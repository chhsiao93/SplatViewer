import { Script, Asset } from 'playcanvas';

/**
 * Downloads all frames upfront as blobs, then replays them from memory.
 * Multiple instances sharing the same `groupId` use a single frame clock,
 * guaranteeing sync because frame advancement is driven by one counter
 * rather than per-instance async asset loading.
 *
 * Static control API (call from HTML after importing this module):
 *   GsplatPreload.play(groupId)
 *   GsplatPreload.pause(groupId)
 *   GsplatPreload.seek(groupId, frameNum)
 *   GsplatPreload.groups.get(groupId)  // { currentFrame, playing, ... }
 */
class GsplatPreload extends Script {
    static scriptName = 'gsplatPreload';

    /**
     * Shared playback state per group.
     * @type {Map<string, {currentFrame:number, frameTime:number, playing:boolean, readyCount:number, memberCount:number, downloaded:number, totalToDownload:number}>}
     */
    static groups = new Map();

    /** @attribute @type {number} */ fps = 5;
    /** @attribute @type {string} */ folder = '';
    /** @attribute @type {string} */ filenamePattern = 'frame_{frame:04}.sog';
    /** @attribute @type {number} */ startFrame = 0;
    /** @attribute @type {number} */ endFrame = 49;
    /**
     * Sync group ID. Instances sharing the same ID share one frame clock.
     * The first instance to initialize becomes the master that drives time.
     * @attribute @type {string}
     */
    groupId = '';

    initialize() {
        this.blobs = [];
        this.downloadedCount = 0;
        this.totalFrames = this.endFrame - this.startFrame + 1;
        this.displayedFrame = null;
        this.currentAsset = null;
        this.currentBlobUrl = null;
        this._pendingAsset = null;
        this._pendingBlobUrl = null;
        this.isMaster = false;
        this.groupRef = null;

        if (this.groupId) {
            if (!GsplatPreload.groups.has(this.groupId)) {
                GsplatPreload.groups.set(this.groupId, {
                    currentFrame: this.startFrame,
                    frameTime: 0,
                    playing: false,
                    readyCount: 0,
                    memberCount: 0,
                    downloaded: 0,
                    totalToDownload: 0,
                });
                this.isMaster = true;
            }
            this.groupRef = GsplatPreload.groups.get(this.groupId);
            this.groupRef.memberCount++;
            this.groupRef.totalToDownload += this.totalFrames;
        }

        if (!this.entity.gsplat) {
            console.error('GsplatPreload: entity needs a gsplat component');
            return;
        }

        this._downloadAll();
    }

    _downloadAll() {
        const pcApp = document.querySelector('pc-app');
        for (let i = this.startFrame; i <= this.endFrame; i++) {
            const frameNum = i;
            fetch(this._framePath(frameNum))
                .then(r => {
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    return r.blob();
                })
                .then(blob => {
                    this.blobs[frameNum] = blob;
                    this.downloadedCount++;

                    if (this.groupRef) {
                        this.groupRef.downloaded++;
                        // Only master fires aggregate progress to avoid duplicate events
                        if (this.isMaster) {
                            pcApp?.dispatchEvent(new CustomEvent('flipbook-progress', {
                                detail: {
                                    groupId: this.groupId,
                                    loaded: this.groupRef.downloaded,
                                    total: this.groupRef.totalToDownload,
                                }
                            }));
                        }
                    }

                    if (this.downloadedCount === this.totalFrames) {
                        this._onAllDownloaded();
                    }
                })
                .catch(err => console.error(`GsplatPreload: frame ${frameNum} failed:`, err));
        }
    }

    _onAllDownloaded() {
        if (!this.groupRef) return;
        this.groupRef.readyCount++;
        if (this.groupRef.readyCount === this.groupRef.memberCount) {
            this.groupRef.playing = true;
            document.querySelector('pc-app')?.dispatchEvent(
                new CustomEvent('flipbook-ready', { detail: { groupId: this.groupId } })
            );
        }
    }

    update(dt) {
        if (!this.groupRef?.playing) return;

        // Only master advances the shared clock
        if (this.isMaster) {
            this.groupRef.frameTime += dt;
            if (this.groupRef.frameTime >= 1 / this.fps) {
                this.groupRef.frameTime -= 1 / this.fps;
                let next = this.groupRef.currentFrame + 1;
                if (next > this.endFrame) next = this.startFrame;
                this.groupRef.currentFrame = next;
            }
        }

        // Both master and follower display whenever the shared frame changes
        if (this.groupRef.currentFrame !== this.displayedFrame) {
            this.displayedFrame = this.groupRef.currentFrame;
            this._showFrame(this.groupRef.currentFrame);
        }
    }

    _showFrame(frameNum) {
        // Cancel any in-flight load that's now stale
        if (this._pendingAsset) {
            this._pendingAsset.off('load');
            this.app.assets.remove(this._pendingAsset);
            this._pendingAsset.unload();
            if (this._pendingBlobUrl) URL.revokeObjectURL(this._pendingBlobUrl);
            this._pendingAsset = null;
            this._pendingBlobUrl = null;
        }

        const blob = this.blobs[frameNum];
        if (!blob) return;

        const blobUrl = URL.createObjectURL(blob);
        const asset = new Asset(`${this.entity.name}_f${frameNum}`, 'gsplat',
            { url: blobUrl, filename: 'frame.sog' }, { reorder: false });
        this.app.assets.add(asset);
        this.app.assets.load(asset);

        this._pendingAsset = asset;
        this._pendingBlobUrl = blobUrl;

        asset.once('load', () => {
            if (this._pendingAsset !== asset) return; // Superseded by a newer seek

            if (this.entity.gsplat) this.entity.gsplat.asset = asset;

            const prevAsset    = this.currentAsset;
            const prevBlobUrl  = this.currentBlobUrl;
            this.currentAsset  = asset;
            this.currentBlobUrl = blobUrl;
            this._pendingAsset  = null;
            this._pendingBlobUrl = null;

            // Defer old-asset cleanup by one render frame so PlayCanvas has a
            // chance to render the new asset before the old GPU resource is freed.
            requestAnimationFrame(() => {
                if (prevAsset) {
                    this.app.assets.remove(prevAsset);
                    prevAsset.unload();
                }
                if (prevBlobUrl) URL.revokeObjectURL(prevBlobUrl);
            });
        });
    }

    _framePath(frameNum) {
        const filename = this.filenamePattern.replace(/\{frame(?::(\d+))?\}/g, (_m, p) =>
            p ? frameNum.toString().padStart(parseInt(p, 10), '0') : frameNum.toString()
        );
        let path = this.folder;
        if (path && !path.endsWith('/')) path += '/';
        return path + filename;
    }

    // ── Static control API ────────────────────────────────────────────────────

    static play(groupId) {
        const g = GsplatPreload.groups.get(groupId);
        if (g) g.playing = true;
    }

    static pause(groupId) {
        const g = GsplatPreload.groups.get(groupId);
        if (g) g.playing = false;
    }

    static seek(groupId, frameNum) {
        const g = GsplatPreload.groups.get(groupId);
        if (g) { g.currentFrame = frameNum; g.frameTime = 0; }
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────

    onDestroy() {
        if (this.groupRef) {
            this.groupRef.memberCount--;
            if (this.isMaster) GsplatPreload.groups.delete(this.groupId);
        }
        if (this._pendingAsset) {
            this._pendingAsset.off('load');
            this.app.assets.remove(this._pendingAsset);
            this._pendingAsset.unload();
            if (this._pendingBlobUrl) URL.revokeObjectURL(this._pendingBlobUrl);
        }
        if (this.currentAsset) {
            this.app.assets.remove(this.currentAsset);
            this.currentAsset.unload();
        }
        if (this.currentBlobUrl) URL.revokeObjectURL(this.currentBlobUrl);
        this.blobs = [];
    }
}

export { GsplatPreload };
