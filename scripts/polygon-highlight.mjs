import {
    Script, Mesh, MeshInstance, StandardMaterial, Color,
    PRIMITIVE_LINES, PRIMITIVE_TRIANGLES, BLEND_NORMAL, CULLFACE_NONE, Entity
} from 'playcanvas';

/**
 * Draws one or more polygon / arrow highlights triggered by the sibling
 * annotation script's show/hide events.
 *
 * Attribute `shapes` — array of shape configs:
 *   Polygon: { type:"polygon", points:[[x,y],...], color:[r,g,b], opacity:0.35, z:0 }
 *   Arrow:   { type:"arrow", from:[x,y], to:[x,y], headSize:0.12, color:[r,g,b], opacity:0.35, z:0 }
 *
 * `z` inside each shape overrides the top-level `zOffset`.
 * Coordinates are in scene-entity local XY space.
 */
class PolygonHighlight extends Script {
    static scriptName = 'polygonHighlight';

    static attributes = {
        shapes:  { type: 'json' },                // array of shape configs
        zOffset: { type: 'number', default: 0 }   // default Z for all shapes
    };

    initialize() {
        this._poly = null;
        this._build();

        const annot = this.entity.script?.annotation;
        if (annot) {
            annot.on('show', () => { if (this._poly) this._poly.enabled = true;  });
            annot.on('hide', () => { if (this._poly) this._poly.enabled = false; });
        }
    }

    _build() {
        if (!this.shapes?.length) return;

        const mis = [];
        for (const shape of this.shapes) {
            const z   = shape.z ?? this.zOffset ?? 0;
            const col = shape.color ?? [1, 0, 0];
            const opa = shape.opacity ?? 0.35;

            if (shape.type === 'polygon' && shape.points?.length >= 3) {
                mis.push(...this._polygonMeshes(shape.points, z, col, opa));
            } else if (shape.type === 'arrow' && shape.from && shape.to) {
                const pts = this._arrowVerts(shape.from, shape.to, shape.headSize ?? 0.12);
                if (pts) mis.push(...this._arrowMeshes(pts, z, col, opa));
            } else if (shape.type === 'star' && shape.center) {
                const pts = this._starVerts(shape.center, shape.outerRadius ?? 0.1,
                    shape.innerRadius ?? (shape.outerRadius ?? 0.1) * 0.4,
                    shape.points ?? 5);
                mis.push(...this._starMeshes(pts, shape.center, z, col, opa));
            }
        }

        if (mis.length === 0) return;

        // Use the HotspotOverlay layer created by annotationManager so the
        // polygon renders AFTER the gsplat, not before it.
        const overlayLayer = this.app.scene.layers.getLayerByName('HotspotOverlay');
        const renderOpts = { meshInstances: mis };
        if (overlayLayer) renderOpts.layers = [overlayLayer.id];

        this._poly = new Entity('poly-highlight');
        this._poly.addComponent('render', renderOpts);
        this._poly.enabled = false;
        this.entity.parent.addChild(this._poly);
    }

    // ── Material ─────────────────────────────────────────────────────────────

    _mat(col, opa, fill) {
        const mat = new StandardMaterial();
        mat.emissive  = new Color(col[0], col[1], col[2]);
        mat.diffuse   = new Color(0, 0, 0);
        mat.cull      = CULLFACE_NONE;
        mat.depthTest = false;
        if (fill) {
            mat.opacity    = opa;
            mat.blendType  = BLEND_NORMAL;
            mat.depthWrite = false;
        }
        mat.update();
        return mat;
    }

    // ── Mesh instance ─────────────────────────────────────────────────────────

    _mi(positions, primitive, col, opa) {
        const nv = positions.length / 3;
        const normals = [];
        for (let i = 0; i < nv; i++) normals.push(0, 1, 0);
        const mesh = new Mesh(this.app.graphicsDevice);
        mesh.setPositions(positions);
        mesh.setNormals(normals);
        mesh.update(primitive);
        const mi = new MeshInstance(mesh, this._mat(col, opa, primitive === PRIMITIVE_TRIANGLES));
        mi.cull = false;
        return mi;
    }

    // ── Convex polygon ────────────────────────────────────────────────────────

    _polygonMeshes(pts, z, col, opa) {
        const n = pts.length;

        const linePos = [];
        for (let i = 0; i < n; i++) {
            const [x0, y0] = pts[i];
            const [x1, y1] = pts[(i + 1) % n];
            linePos.push(x0, y0, z, x1, y1, z);
        }

        const fillPos = [];
        for (let i = 1; i < n - 1; i++) {
            fillPos.push(pts[0][0], pts[0][1], z,
                         pts[i][0], pts[i][1], z,
                         pts[i+1][0], pts[i+1][1], z);
        }

        return [this._mi(linePos, PRIMITIVE_LINES, col, opa),
                this._mi(fillPos, PRIMITIVE_TRIANGLES, col, opa)];
    }

    // ── Arrow ─────────────────────────────────────────────────────────────────

    _arrowVerts(from, to, headLen) {
        const [x0, y0] = from;
        const [x1, y1] = to;
        const dx = x1 - x0, dy = y1 - y0;
        const len = Math.sqrt(dx*dx + dy*dy);
        if (len < 1e-6) return null;

        const ux = dx / len, uy = dy / len;
        const px = -uy,      py = ux;

        const hl = Math.min(headLen, len * 0.5);
        const hw = hl * 0.8;
        const sw = hl * 0.25;
        const nx = x1 - ux * hl, ny = y1 - uy * hl;

        return [
            [x1,          y1         ],  // 0 tip
            [nx + px*hw,  ny + py*hw ],  // 1 right wing
            [nx + px*sw,  ny + py*sw ],  // 2 right notch
            [x0 + px*sw,  y0 + py*sw ],  // 3 right base
            [x0 - px*sw,  y0 - py*sw ],  // 4 left base
            [nx - px*sw,  ny - py*sw ],  // 5 left notch
            [nx - px*hw,  ny - py*hw ],  // 6 left wing
        ];
    }

    _arrowMeshes(pts, z, col, opa) {
        const n = pts.length;

        const linePos = [];
        for (let i = 0; i < n; i++) {
            const [x0, y0] = pts[i];
            const [x1, y1] = pts[(i + 1) % n];
            linePos.push(x0, y0, z, x1, y1, z);
        }

        // Custom triangulation: head [0,1,2],[0,2,5],[0,5,6]  shaft [2,3,4],[2,4,5]
        const triIdx = [0,1,2, 0,2,5, 0,5,6, 2,3,4, 2,4,5];
        const fillPos = [];
        for (const i of triIdx) {
            fillPos.push(pts[i][0], pts[i][1], z);
        }

        return [this._mi(linePos, PRIMITIVE_LINES, col, opa),
                this._mi(fillPos, PRIMITIVE_TRIANGLES, col, opa)];
    }

    // ── Star ──────────────────────────────────────────────────────────────────

    // Returns 2*nPoints vertices alternating outer/inner radius, tip at top.
    _starVerts(center, outerR, innerR, nPoints) {
        const [cx, cy] = center;
        const pts = [];
        for (let i = 0; i < nPoints * 2; i++) {
            const angle = -Math.PI / 2 + (i * Math.PI) / nPoints;
            const r = i % 2 === 0 ? outerR : innerR;
            pts.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
        }
        return pts;
    }

    _starMeshes(pts, center, z, col, opa) {
        const n = pts.length;
        const [cx, cy] = center;

        // Outline: closed line loop through all star vertices
        const linePos = [];
        for (let i = 0; i < n; i++) {
            const [x0, y0] = pts[i];
            const [x1, y1] = pts[(i + 1) % n];
            linePos.push(x0, y0, z, x1, y1, z);
        }

        // Fill: center-fan triangulation — works for any star (concave polygon)
        const fillPos = [];
        for (let i = 0; i < n; i++) {
            const [x0, y0] = pts[i];
            const [x1, y1] = pts[(i + 1) % n];
            fillPos.push(cx, cy, z, x0, y0, z, x1, y1, z);
        }

        return [this._mi(linePos, PRIMITIVE_LINES, col, opa),
                this._mi(fillPos, PRIMITIVE_TRIANGLES, col, opa)];
    }

    destroy() {
        this._poly?.destroy();
    }
}

export { PolygonHighlight };
