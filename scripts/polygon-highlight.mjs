import {
    Script, Mesh, MeshInstance, StandardMaterial, Color,
    PRIMITIVE_LINES, PRIMITIVE_TRIANGLES, BLEND_NORMAL, CULLFACE_NONE, Entity
} from 'playcanvas';

/**
 * Draws one or more polygon / arrow highlights triggered by the sibling
 * annotation script's show/hide events.
 *
 * Attribute `shapes` — array of shape configs:
 *   Polygon:     { type:"polygon", points:[[x,y],...],
 *                  cornerRadius:0.03, arcSegs:8,
 *                  dash:0.025, gap:0.015, lineWidth:0.005,
 *                  color:[r,g,b], opacity:0.35, fillOpacity:0.1, z:0 }
 *                  `cornerRadius`, `dash`/`gap`, `lineWidth`, `fillOpacity` are all optional.
 *                  `lineWidth` is in scene units; omit (or 0) for a 1-px hairline.
 *                  WebGL caps gl.lineWidth to 1 px on most GPUs, so thick outlines
 *                  are rendered as quads when `lineWidth` is set.
 *   Arrow:       { type:"arrow", from:[x,y], to:[x,y], headSize:0.12, color:[r,g,b], opacity:0.35, z:0 }
 *   RoundedRect: { type:"roundedRect", center:[x,y], width:w, height:h, radius:r,
 *                  dash:0.025, gap:0.015, arcSegs:12,
 *                  color:[r,g,b], opacity:0.7, fillOpacity:0.15, z:0 }
 *                  Axis-aligned only; for a rotated rectangle use `polygon` with 4 points.
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
                mis.push(...this._polygonMeshes(shape, z, col, opa));
            } else if (shape.type === 'arrow' && shape.from && shape.to) {
                const pts = this._arrowVerts(shape.from, shape.to, shape.headSize ?? 0.12, shape.shaftWidth, shape.headRatio, shape.headWidth);
                if (pts) mis.push(...this._arrowMeshes(pts, z, col, opa));
            } else if (shape.type === 'roundedRect' && shape.center) {
                mis.push(...this._roundedRectMeshes(shape, z, col, opa));
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

    _polygonMeshes(shape, z, col, opa) {
        const rawPts  = shape.points;
        const radius  = shape.cornerRadius ?? 0;
        const arcSegs = shape.arcSegs ?? 8;
        const fopa    = shape.fillOpacity !== undefined ? shape.fillOpacity : opa;

        const pts = radius > 0 ? this._smoothPolyPath(rawPts, radius, arcSegs) : rawPts;
        const m   = pts.length;

        const dash = shape.dash ?? 0;
        const gap  = shape.gap  ?? dash * 0.6;
        const lw   = shape.lineWidth ?? 0;
        const linePos = lw > 0
            ? this._pathQuadPositions(pts, z, dash, gap, lw / 2)
            : this._pathLinePositions(pts, z, dash, gap);
        const linePrim = lw > 0 ? PRIMITIVE_TRIANGLES : PRIMITIVE_LINES;

        // Fill: center-fan triangulation (works for convex & star-shaped polygons)
        let cx = 0, cy = 0;
        for (const [px, py] of pts) { cx += px; cy += py; }
        cx /= m; cy /= m;
        const fillPos = [];
        for (let i = 0; i < m; i++) {
            const [x0, y0] = pts[i];
            const [x1, y1] = pts[(i + 1) % m];
            fillPos.push(cx, cy, z, x0, y0, z, x1, y1, z);
        }

        return [this._mi(linePos, linePrim, col, opa),
                this._mi(fillPos, PRIMITIVE_TRIANGLES, col, fopa)];
    }

    // Returns a closed array of [x,y] path points with rounded corners.
    // Uses the standard cutback formula: cutback = r·tan(α/2) where α is the
    // turning angle at the vertex. A quarter-circle arc replaces each sharp corner.
    _smoothPolyPath(rawPts, radius, arcSegs) {
        const n    = rawPts.length;
        const path = [];

        for (let i = 0; i < n; i++) {
            const P = rawPts[(i - 1 + n) % n];
            const V = rawPts[i];
            const N = rawPts[(i + 1) % n];

            const d1x = V[0]-P[0], d1y = V[1]-P[1];
            const d1len = Math.sqrt(d1x*d1x + d1y*d1y);
            if (d1len < 1e-9) continue;
            const d1 = [d1x/d1len, d1y/d1len];

            const d2x = N[0]-V[0], d2y = N[1]-V[1];
            const d2len = Math.sqrt(d2x*d2x + d2y*d2y);
            if (d2len < 1e-9) continue;
            const d2 = [d2x/d2len, d2y/d2len];

            const crossZ = d1[0]*d2[1] - d1[1]*d2[0];
            const dotVal = d1[0]*d2[0] + d1[1]*d2[1];

            if (Math.abs(crossZ) < 1e-6) {
                path.push([V[0], V[1]]);
                continue;
            }

            // cutback = r·|sinα| / (1 + cosα) = r·tan(α/2)
            const sinA    = Math.abs(crossZ);
            const tanHalf = sinA / (1 + dotVal);
            const rawCB   = radius * tanHalf;
            // clamp so we never exceed half the adjacent edge lengths
            const cutback = Math.min(rawCB, d1len * 0.49, d2len * 0.49);
            const r       = cutback / tanHalf;   // actual radius after clamping

            const T1 = [V[0] - cutback * d1[0], V[1] - cutback * d1[1]];
            const T2 = [V[0] + cutback * d2[0], V[1] + cutback * d2[1]];

            // Arc center: perp to d1 at T1; sign(crossZ) picks the correct side
            const ps = crossZ > 0 ? 1 : -1;
            const C  = [T1[0] + ps * r * (-d1[1]),
                        T1[1] + ps * r *   d1[0] ];

            const startA = Math.atan2(T1[1]-C[1], T1[0]-C[0]);
            const endA   = Math.atan2(T2[1]-C[1], T2[0]-C[0]);

            let sweep = endA - startA;
            if (crossZ > 0 && sweep < 0) sweep += 2 * Math.PI;
            if (crossZ < 0 && sweep > 0) sweep -= 2 * Math.PI;

            for (let j = 0; j <= arcSegs; j++) {
                const a = startA + sweep * j / arcSegs;
                path.push([C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)]);
            }
        }
        return path;
    }

    // ── Arrow ─────────────────────────────────────────────────────────────────

    _arrowVerts(from, to, headLen, shaftWidth, headRatio, headWidth) {
        const [x0, y0] = from;
        const [x1, y1] = to;
        const dx = x1 - x0, dy = y1 - y0;
        const len = Math.sqrt(dx*dx + dy*dy);
        if (len < 1e-6) return null;

        const ux = dx / len, uy = dy / len;
        const px = -uy,      py = ux;

        const hl = headRatio !== undefined
            ? Math.min(len * headRatio, len * 0.95)
            : Math.min(headLen, len * 0.5);
        const hw = headWidth !== undefined ? headWidth / 2 : hl * 0.8;
        const sw = shaftWidth !== undefined ? Math.min(shaftWidth / 2, hw * 0.9) : hl * 0.25;
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

    // Like _pathLinePositions but renders each segment as a screen-space quad
    // so the outline has a controllable width (hw = half lineWidth, in scene units).
    _pathQuadPositions(pts, z, dash, gap, hw) {
        const pos    = [];
        const n      = pts.length;
        const dashed = dash > 0;
        let acc = 0, drawing = true;

        for (let i = 0; i < n; i++) {
            const [x0, y0] = pts[i];
            const [x1, y1] = pts[(i + 1) % n];
            const edx = x1-x0, edy = y1-y0;
            const segLen = Math.sqrt(edx*edx + edy*edy);
            if (segLen < 1e-9) continue;
            const ux = edx/segLen, uy = edy/segLen;
            const px = -uy * hw, py = ux * hw;  // perpendicular half-width

            if (!dashed) {
                pos.push(
                    x0+px, y0+py, z,  x0-px, y0-py, z,  x1+px, y1+py, z,
                    x0-px, y0-py, z,  x1-px, y1-py, z,  x1+px, y1+py, z
                );
                continue;
            }

            let t = 0;
            while (t < segLen) {
                const phase = drawing ? dash : gap;
                const step  = Math.min(phase - acc, segLen - t);
                if (drawing) {
                    const t0 = t/segLen, t1 = (t+step)/segLen;
                    const ax = x0+t0*edx, ay = y0+t0*edy;
                    const bx = x0+t1*edx, by = y0+t1*edy;
                    pos.push(
                        ax+px, ay+py, z,  ax-px, ay-py, z,  bx+px, by+py, z,
                        ax-px, ay-py, z,  bx-px, by-py, z,  bx+px, by+py, z
                    );
                }
                acc += step; t += step;
                if (acc >= phase) { acc = 0; drawing = !drawing; }
            }
        }
        return pos;
    }

    // ── Rounded rectangle ─────────────────────────────────────────────────────

    // Returns a closed array of [x,y] path points tracing a rounded rectangle.
    _roundedRectPath(cx, cy, width, height, radius, arcSegs) {
        const hw = width / 2, hh = height / 2;
        const r = Math.min(Math.abs(radius), hw, hh);
        const pts = [];
        // Corner center offsets (cx±(hw-r), cy±(hh-r)), arc angle range per corner.
        const corners = [
            [cx + hw - r, cy + hh - r,  0,            Math.PI / 2    ],
            [cx - hw + r, cy + hh - r,  Math.PI / 2,  Math.PI        ],
            [cx - hw + r, cy - hh + r,  Math.PI,      3 * Math.PI / 2],
            [cx + hw - r, cy - hh + r,  3 * Math.PI / 2, 2 * Math.PI ],
        ];
        for (const [ox, oy, a0, a1] of corners) {
            for (let i = 0; i <= arcSegs; i++) {
                const a = a0 + (a1 - a0) * i / arcSegs;
                pts.push([ox + Math.cos(a) * r, oy + Math.sin(a) * r]);
            }
        }
        return pts;
    }

    // Walks a closed path and returns flat positions for PRIMITIVE_LINES,
    // emitting only the "on" intervals when dash/gap are given.
    _pathLinePositions(pts, z, dash, gap) {
        const linePos = [];
        const n = pts.length;
        const dashed = dash > 0;
        let acc = 0, drawing = true;

        for (let i = 0; i < n; i++) {
            const [x0, y0] = pts[i];
            const [x1, y1] = pts[(i + 1) % n];
            const dx = x1 - x0, dy = y1 - y0;
            const segLen = Math.sqrt(dx * dx + dy * dy);
            if (segLen < 1e-9) continue;

            if (!dashed) {
                linePos.push(x0, y0, z, x1, y1, z);
                continue;
            }

            let t = 0;
            while (t < segLen) {
                const phase = drawing ? dash : gap;
                const step  = Math.min(phase - acc, segLen - t);
                if (drawing) {
                    const t0 = t / segLen, t1 = (t + step) / segLen;
                    linePos.push(
                        x0 + t0 * dx, y0 + t0 * dy, z,
                        x0 + t1 * dx, y0 + t1 * dy, z
                    );
                }
                acc += step;
                t   += step;
                if (acc >= phase) { acc = 0; drawing = !drawing; }
            }
        }
        return linePos;
    }

    _roundedRectMeshes(shape, z, col, opa) {
        const { center, width, height, radius = 0, arcSegs = 12,
                dash = 0, gap, fillOpacity, lineWidth = 0 } = shape;
        const [cx, cy] = center;
        const fopa = fillOpacity ?? opa * 0.2;
        const g    = gap ?? dash * 0.6;

        const pts     = this._roundedRectPath(cx, cy, width, height, radius, arcSegs);
        const linePos = lineWidth > 0
            ? this._pathQuadPositions(pts, z, dash, g, lineWidth / 2)
            : this._pathLinePositions(pts, z, dash, g);
        const linePrim = lineWidth > 0 ? PRIMITIVE_TRIANGLES : PRIMITIVE_LINES;

        // Fill: center-fan triangulation
        const fillPos = [];
        const n = pts.length;
        for (let i = 0; i < n; i++) {
            const [x0, y0] = pts[i];
            const [x1, y1] = pts[(i + 1) % n];
            fillPos.push(cx, cy, z, x0, y0, z, x1, y1, z);
        }

        const mis = [this._mi(linePos, linePrim, col, opa)];
        if (fopa > 0 && fillPos.length > 0) {
            mis.push(this._mi(fillPos, PRIMITIVE_TRIANGLES, col, fopa));
        }
        return mis;
    }

    destroy() {
        this._poly?.destroy();
    }
}

export { PolygonHighlight };
