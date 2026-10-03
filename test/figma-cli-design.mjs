// Tidepool as `figma-cli snapshot` writes it, for the figma-cli tests.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TP = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tidepool-figma');
const json = (p) => JSON.parse(readFileSync(join(TP, p), 'utf8'));
const tpVars = json('src/figma/figma-vars.snapshot.json');
const tpStruct = json('src/figma/figma-structure.snapshot.json').components;

// Tidepool as `figma-cli snapshot` writes it (format v2): variables by collection with every mode, aliases as
// { alias, collection }, bound variables as `collection:name`, and each component set's first variant walked.
export function tidepoolDesign() {
  const light = tpVars.color.light, dark = tpVars.color.dark;
  const theme = Object.keys(light).map((name) => ({ name, type: 'COLOR', values: { Light: light[name], Dark: dark[name] } }));
  // The button's colour goes through a primitive in another collection, as a real system does.
  const prim = { name: 'Primitives', modes: ['Value'], variables: [
    { name: 'primitives/blue/600', type: 'COLOR', values: { Value: light['button/background/color'].toUpperCase() } }] };
  theme.find((v) => v.name === 'button/background/color').values.Light = { alias: 'primitives/blue/600', collection: 'Primitives' };
  const sizing = Object.entries(tpVars.sizing).map(([name, v]) => ({ name, type: 'FLOAT', values: { Mode: parseFloat(v) } }));
  const t = (name) => `Theme:${name}`, s = (name) => `Sizing:${name}`;
  const variant = (c) => {
    const k = { t: 'COMPONENT', n: c.defaultVariant, h: c.h, w: 80, bv: {}, kids: [] };
    if (c.paddingVar) Object.assign(k.bv, { paddingTop: s(c.paddingVar.tb), paddingBottom: s(c.paddingVar.tb), paddingLeft: s(c.paddingVar.lr), paddingRight: s(c.paddingVar.lr) });
    if (c.gapVar) k.bv.itemSpacing = s(c.gapVar);
    if (c.innerRadiusVar) Object.assign(k.bv, { topLeftRadius: s(c.innerRadiusVar), topRightRadius: s(c.innerRadiusVar) });
    if (c.colors?.fill?.token) { k.bv.fills = [t(c.colors.fill.token)]; k.fills = [light[c.colors.fill.token]]; }
    if (c.colors?.stroke?.token) { k.bv.strokes = [t(c.colors.stroke.token)]; k.strokes = [light[c.colors.stroke.token]]; k.sw = 1; }
    const text = { t: 'TEXT', n: 'Label', txt: { chars: 'x', size: 12 } };
    if (c.colors?.text?.token) { text.bv = { fills: [t(c.colors.text.token)] }; text.fills = [light[c.colors.text.token]]; }
    k.kids.push(text);
    return k;
  };
  const sets = Object.entries(tpStruct).map(([n, c]) => ({ t: 'COMPONENT_SET', n, vp: {}, kids: [variant(c)] }));
  sets.find((x) => x.n === 'chip').vp = { Size: { values: ['M', 'L'] }, Icon: { values: ['False', 'True'] } };
  // A raw colour on a variant (no variable bound) stays a raw value.
  const tag = sets.find((x) => x.n === 'tag'); tag.kids[0] = { ...tag.kids[0], n: 'Tone=Positive', bv: { ...tag.kids[0].bv, fills: undefined }, fills: ['#D6F5E3'] };
  delete tag.kids[0].bv.fills;
  return {
    version: 2, meta: { file: 'Tidepool', extractedAt: '2026-10-02', scope: null },
    pages: [{ name: 'Components', nodeCount: 40, frames: [{ t: 'FRAME', n: 'Library', kids: sets }, { t: 'COMPONENT_SET', n: '_private', vp: {}, kids: [] }] }],
    variables: [prim, { name: 'Sizing', modes: ['Mode'], variables: sizing }, { name: 'Theme', modes: ['Dark', 'Light'], variables: theme }],
  };
}

