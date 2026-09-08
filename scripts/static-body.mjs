import { Script } from 'playcanvas';

export class StaticBody extends Script {
    static scriptName = 'staticBody';

    initialize() {
        const ent = this.entity;
        const renders = ent.findComponents('render');

        if (renders.length) {
            renders.forEach((render) => {
                const e = render.entity;

                // render.meshInstances?.forEach(mi => { mi.visible = false; });
                // render.enabled = false;

                if (!e.rigidbody) e.addComponent('rigidbody', { type: 'static' });
                if (!e.collision)  e.addComponent('collision', { type: 'mesh', renderAsset: render.asset });
            });
            return;
        }

        // Old model-component API fallback
        if (ent.model) {
            if (!ent.rigidbody) ent.addComponent('rigidbody', { type: 'static' });
            if (!ent.collision)  ent.addComponent('collision', { type: 'mesh', asset: ent.model.asset });
            ent.model.enabled = false;
        }
    }
}
