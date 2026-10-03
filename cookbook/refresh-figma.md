# Refresh the Figma data

**Use when.** the Figma snapshots are stale, the person says the design changed, or a scoped or full audit needs fresh data.

## Steps

1. Run `rms-design-system-engine --refresh-figma` first. It picks the best way to read Figma: a `design.json` newer than the snapshots, else figma-cli when Figma Desktop is connected to it (it runs `figma-cli snapshot` and reads the result), else it says the Figma tool of this session reads it (the steps below), or the API with FIGMA_TOKEN. A design.json read this way keeps what it does not hold (text styles, other variants, descriptions, annotations) from the snapshots already there.
2. Otherwise refresh only with a capture faithful to the steps below (the Plugin API capture works on any plan). Never hand-edit a snapshot: the project's hooks refuse it.
3. When no refresh path is available (no figma-cli, no token, no Figma MCP, no Plugin API), say so and audit the committed snapshots.
4. After a refresh, run the audit (`--recipe full-audit` or `--recipe audit-component`).

Always: relay the SUMMARY block as it is, then follow its `NEXT:` line. Change code, config or snapshots only when the person asks for that change.

## Read more

- `rms-design-system-engine --reference config`: *Snapshot Files*

```recipe-check
rms-design-system-engine --summary
```

---

# PHASE 1 - Figma Refresh

---


## Read every mode

A single-mode read is never enough. When someone hands you a Figma link and asks
for the value behind it, `get_variable_defs` (and any Dev Mode read) resolves only the
mode the frame is *currently* displaying. Acting on that one value silently guesses
every other mode. Always resolve the variable across **all** modes of its collection,
following the alias chain in each one - the same variable can alias different
primitives per mode. Read it with the Plugin API rather than a Dev Mode value:

```js
const v    = await figma.variables.getVariableByIdAsync(varId);
const coll = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
for (const m of coll.modes) { /* v.valuesByMode[m.modeId] - recurse on VARIABLE_ALIAS */ }
```

**Capture the metadata too, when you refresh.** Record each variable's own `description` into an
optional `tokenMeta` sidecar in `figma-vars.snapshot.json` — `tokenMeta["<slashed/name>"] =
{ description, deprecated }`, with `deprecated: true` when the description carries a `@deprecated`
marker — and the component's `description` into the component-props snapshot. The contract emitter
surfaces these as DTCG `$description` / `$deprecated` and the component `description`; when they are
absent it falls back cleanly, never inventing them. (Figma component-property definitions carry no
per-prop description, so a prop's `description` is authored in `contract.authored.json` under
`components[name].propDescriptions`.)

Real case (2026-07-30): `node/icon/hover/color` read from a dark frame returned
`#b8b8b8`. It actually aliases `node/icon/selected/color`, which resolves to
Neutral 300 in dark but Neutral **400** (`#595959`) in light. Patching from the
single dark read would have left light on the old, unrelated value.

## Phase 1 - Step 1: Query live Figma values

> **⚠️ Figma MCP 20 kb limit:** the `use_figma` tool silently truncates responses above ~20 kb. A single query for a large collection (>200 tokens) will be cut off mid-JSON with no error. **Always run the probe first to check the count, then decide whether to batch.**

### Step 1a - Probe (always run first)

Fill in `COLOR_COLLECTION`, `SIZING_COLLECTION` (or `null`), and `PRIMITIVE_PREFIX` from `ds-config.json`.

```js
const collections = await figma.variables.getLocalVariableCollectionsAsync();
const idToVar = {};
for (const col of collections) {
  for (const id of col.variableIds) {
    const v = await figma.variables.getVariableByIdAsync(id); if (v) idToVar[id] = v;
  }
}
const COLOR_COLLECTION  = 'Theme';       // figma.colorCollection from ds-config.json
const SIZING_COLLECTION = 'Sizing';      // figma.sizingCollection (or null)
const PRIMITIVE_PREFIX  = 'primitives/'; // figma.primitivePrefix
const col = collections.find(c => c.name === COLOR_COLLECTION);
const colorVarIds = col.variableIds.filter(id => {
  const v = idToVar[id];
  return v && v.resolvedType === 'COLOR' && !v.name.startsWith(PRIMITIVE_PREFIX);
});
const sizingCol = SIZING_COLLECTION ? collections.find(c => c.name === SIZING_COLLECTION) : null;
return {
  colorCount: colorVarIds.length,
  sizingCount: sizingCol?.variableIds.length ?? 0,
  modes: col.modes.map(m => m.name),
};
```

**Decision after probe:**
- `colorCount ≤ 190` → run the single-pass query (Step 1b-single).
- `colorCount > 190` → run batched queries (Step 1b-batched): `Math.ceil(colorCount / 190)` calls, each using `slice(i*190, (i+1)*190)`.

---

> **Capture fidelity - a lossy capture is worse than a stale one.** A stale snapshot is
> at least *correct as of its stamp*; a lossy one is wrong the moment it is written, and
> it reports itself as fresh. Two losses are easy to introduce and hard to notice, because
> both produce a plausible-looking value:
>
> - **Alpha.** A `toHex` over `{r,g,b}` alone flattens every translucent token to its
>   opaque hex. An overlay/scrim token captured as `#f2f2f2` instead of `#f2f2f2e0` then
>   "matches" opaque CSS and the gate confirms a divergence as correct. Always emit the
>   alpha byte when `color.a < 1`.
> - **Float noise.** Figma stores sizing as 32-bit floats, so a 1.2px stroke reads back as
>   `1.2000000476837158`. Unrounded, every run diffs against the previous one and the
>   snapshot churns forever. Round to 3dp.
>
> If a refreshed snapshot diffs against the stored one, rule out the capture before
> concluding the DS changed - compare a token you know is untouched.

### Step 1b-single - Full query (≤190 tokens)

Use this when `colorCount ≤ 190`. Returns everything in one call.

```js
function toHex(c){const h=[c.r,c.g,c.b].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');const a=c.a===undefined?1:c.a;return '#'+h+(a>=1?'':Math.round(a*255).toString(16).padStart(2,'0'));}
const collections=await figma.variables.getLocalVariableCollectionsAsync();
const idToVar={};
for(const col of collections){for(const id of col.variableIds){const v=await figma.variables.getVariableByIdAsync(id);if(v)idToVar[id]=v;}}
function resolve(varId,modeId,d=0){if(d>10)return null;const v=idToVar[varId];if(!v)return null;const val=v.valuesByMode[modeId]??Object.values(v.valuesByMode)[0];if(!val)return null;if(val?.type==='VARIABLE_ALIAS')return resolve(val.id,modeId,d+1);if('r'in val)return toHex(val);return null;}
function aliasChain(varId,modeId,d=0){if(d>10)return[];const v=idToVar[varId];if(!v)return[];const val=v.valuesByMode[modeId]??Object.values(v.valuesByMode)[0];if(!val||typeof val!=='object'||val.type!=='VARIABLE_ALIAS')return[];const a=idToVar[val.id];if(!a)return[];return[a.name,...aliasChain(val.id,modeId,d+1)];}
// Fill from ds-config.json:
const COLOR_COLLECTION='Theme'; const SIZING_COLLECTION='Sizing'; const PRIMITIVE_PREFIX='primitives/';
const MODES=[{name:'Light',snapshotKey:'light'},{name:'Dark',snapshotKey:'dark'}]; // from figma.modes
const col=collections.find(c=>c.name===COLOR_COLLECTION);
const colorOut={},aliasesOut={};
for(const m of MODES){
  const modeId=col.modes.find(fm=>fm.name===m.name)?.modeId; if(!modeId)continue;
  colorOut[m.snapshotKey]={}; aliasesOut[m.snapshotKey]={};
  for(const id of col.variableIds){
    const v=idToVar[id]; if(!v||v.resolvedType!=='COLOR'||v.name.startsWith(PRIMITIVE_PREFIX))continue;
    colorOut[m.snapshotKey][v.name]=resolve(id,modeId);
    const chain=aliasChain(id,modeId); if(chain.length>0)aliasesOut[m.snapshotKey][v.name]=chain;
  }
}
function resolveScalarVal(id,modeId,d=0){let v=idToVar[id];if(!v)return null;let val=v.valuesByMode[modeId]??Object.values(v.valuesByMode)[0];let n=0;while(typeof val==='object'&&val?.type==='VARIABLE_ALIAS'&&n++<10){const a=idToVar[val.id];val=a?.valuesByMode[modeId]??Object.values(a?.valuesByMode??{})[0];}if(val==null)return null;if(typeof val==='number')return (Math.round(val*1000)/1000)+'px';if(typeof val==='boolean')return String(val);if(typeof val==='object'&&'r'in val)return toHex(val);return String(val);}
const sizingOut={};
if(SIZING_COLLECTION){const sc=collections.find(c=>c.name===SIZING_COLLECTION);if(sc){const mid=sc.modes[0].modeId;for(const id of sc.variableIds){const v=idToVar[id];if(!v)continue;sizingOut[v.name]=resolveScalarVal(id,mid)??'';}}}
// modeVariants - DS-agnostic: for every collection in ds-config → figma.collections with ≥2 modes,
// capture the vars that DIFFER across its modes, tagging EACH with its own kind (inferred from
// resolvedType - a single collection may mix color/scalar/string/boolean). Colours of the colour
// collection are skipped here (already in snap.color). Lets Gate [5] check non-colour, per-collection
// mode axes (breakpoint sizing, per-locale strings) AND mixed-type collections (a Theme whose floats
// and booleans also vary light↔dark).
const COLLECTIONS=[]; // from figma.collections, e.g. [{name:'Breakpoint',modes:[{name:'Phone',snapshotKey:'phone'},{name:'Tablet',snapshotKey:'tablet'}]}]
// Auto-capture a multi-mode SIZING collection (e.g. Desktop/Phone). The flat `sizing`
// bucket above keeps only the FIRST mode (base) for the value gate; its OTHER modes
// would otherwise be lost, so capture them here into modeVariants like any per-mode
// axis (base key 'desktop'; other modes slugified, Phone -> 'phone'). Single-mode
// sizing collections are a no-op. The styleguide's [data-size] axis is built from this.
if(SIZING_COLLECTION){const _s=collections.find(c=>c.name===SIZING_COLLECTION);if(_s&&_s.modes.length>=2&&!COLLECTIONS.some(c=>c.name===SIZING_COLLECTION))COLLECTIONS.push({name:SIZING_COLLECTION,modes:_s.modes.map((m,i)=>({name:m.name,snapshotKey:i===0?'desktop':m.name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}))});}
const KIND={COLOR:'color',FLOAT:'scalar',STRING:'string',BOOLEAN:'boolean'};
const modeVariantsOut={};
for(const cc of COLLECTIONS){const c=collections.find(x=>x.name===cc.name);if(!c||c.modes.length<2)continue;const vars={};for(const id of c.variableIds){const v=idToVar[id];if(!v||v.name.startsWith(PRIMITIVE_PREFIX))continue;const kind=KIND[v.resolvedType]||'scalar';if(kind==='color'&&cc.name===COLOR_COLLECTION)continue;const values={};for(const m of cc.modes){const mid=c.modes.find(fm=>fm.name===m.name)?.modeId;if(!mid)continue;values[m.snapshotKey]=kind==='color'?resolve(id,mid):resolveScalarVal(id,mid);}if(new Set(Object.values(values).map(String)).size>1)vars[v.name]={kind,values};}if(Object.keys(vars).length)modeVariantsOut[cc.name]={modes:cc.modes,vars};}
const WEIGHT={'Thin':100,'Extra Light':200,'Light':300,'Regular':400,'Medium':500,'Semi Bold':600,'Bold':700,'Extra Bold':800,'Black':900};
const styles=await figma.getLocalTextStylesAsync(); const typo={};
for(const st of styles){const key=st.name.trim().toLowerCase().split('/').pop();const entry={size:Math.round(st.fontSize*10)/10+'px'};const w=WEIGHT[st.fontName.style];if(w)entry.weight=String(w);if(st.lineHeight?.unit==='PIXELS')entry.lh=Math.round(st.lineHeight.value*10)/10+'px';if(st.letterSpacing?.value)entry.ls=(st.letterSpacing.unit==='PERCENT'?Math.round(st.letterSpacing.value*100)/10000+'em':Math.round(st.letterSpacing.value*100)/100+'px');if(st.textCase&&st.textCase!=='ORIGINAL')entry.textTransform=(st.textCase==='UPPER'?'uppercase':st.textCase==='LOWER'?'lowercase':st.textCase.toLowerCase());typo[key]=entry;}
return {color:colorOut,aliases:aliasesOut,sizing:sizingOut,typography:typo,modeVariants:modeVariantsOut};
```

---

### Step 1b-batched - Batch queries (>190 tokens)

When `colorCount > 190`, run **one query per batch of 190 tokens**. Each call returns `{tokenName: [lightHex, darkHex]}`. After all batches complete, merge all results into `light{}` and `dark{}` objects.

Run `Math.ceil(colorCount / 190)` calls, substituting `BATCH_START` and `BATCH_END` each time:

```js
// Batch query - substitute BATCH_START and BATCH_END each iteration
// Example: batch 0 → (0, 190), batch 1 → (190, 380), etc.
function toHex(c){const h=[c.r,c.g,c.b].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');const a=c.a===undefined?1:c.a;return '#'+h+(a>=1?'':Math.round(a*255).toString(16).padStart(2,'0'));}
const collections=await figma.variables.getLocalVariableCollectionsAsync();
const idToVar={};
for(const col of collections){for(const id of col.variableIds){const v=await figma.variables.getVariableByIdAsync(id);if(v)idToVar[id]=v;}}
function resolve(varId,modeId,d=0){if(d>10)return null;const v=idToVar[varId];if(!v)return null;const val=v.valuesByMode[modeId]??Object.values(v.valuesByMode)[0];if(!val)return null;if(val?.type==='VARIABLE_ALIAS')return resolve(val.id,modeId,d+1);if('r'in val)return toHex(val);return null;}
// Fill from ds-config.json:
const COLOR_COLLECTION='Theme'; const PRIMITIVE_PREFIX='primitives/';
const MODES=[{name:'Light',snapshotKey:'light'},{name:'Dark',snapshotKey:'dark'}];
const col=collections.find(c=>c.name===COLOR_COLLECTION);
const modeIds=Object.fromEntries(MODES.map(m=>[m.snapshotKey, col.modes.find(fm=>fm.name===m.name)?.modeId]));
const vars=col.variableIds.map(id=>idToVar[id]).filter(v=>v&&v.resolvedType==='COLOR'&&!v.name.startsWith(PRIMITIVE_PREFIX));
const BATCH_START=0, BATCH_END=190; // ← substitute per iteration
const out={};
for(const v of vars.slice(BATCH_START,BATCH_END)){
  out[v.name]=MODES.map(m=>resolve(v.id,modeIds[m.snapshotKey]));
}
return out; // {tokenName: [lightHex, darkHex, ...]} - one value per mode in MODES order
```

**After all batch calls:** merge into per-mode objects:
```
light = {}; dark = {};
for each batch result:
  for each [tokenName, [lightHex, darkHex]] in result:
    light[tokenName] = lightHex
    dark[tokenName]  = darkHex
```

Then fetch **aliases in batches** (same BATCH_SIZE, same iteration count):

```js
// Alias batch - substitute BATCH_START / BATCH_END per iteration
function aliasChain(varId,modeId,d=0){if(d>10)return[];const v=idToVar[varId];if(!v)return[];const val=v.valuesByMode[modeId]??Object.values(v.valuesByMode)[0];if(!val||typeof val!=='object'||val.type!=='VARIABLE_ALIAS')return[];const a=idToVar[val.id];if(!a)return[];return[a.name,...aliasChain(val.id,modeId,d+1)];}
// Reuse collections / idToVar / col / vars / modeIds / MODES from above
const BATCH_START=0, BATCH_END=190;
const out={};
for(const m of MODES){out[m.snapshotKey]={};}
for(const v of vars.slice(BATCH_START,BATCH_END)){
  for(const m of MODES){
    const chain=aliasChain(v.id,modeIds[m.snapshotKey]);
    if(chain.length>0)out[m.snapshotKey][v.name]=chain;
  }
}
return out;
```

Merge alias batches the same way - accumulate into a single `aliases` object keyed by snapshotKey.

Then fetch **sizing and typography** in one separate call (these collections are small enough to avoid truncation):

```js
// Sizing + typography - single call, always safe
const collections=await figma.variables.getLocalVariableCollectionsAsync();
const idToVar={};
for(const col of collections){for(const id of col.variableIds){const v=await figma.variables.getVariableByIdAsync(id);if(v)idToVar[id]=v;}}
const SIZING_COLLECTION='Sizing'; const COLOR_COLLECTION='Theme'; // fill from ds-config.json
function toHex(c){const h=[c.r,c.g,c.b].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');return '#'+h;}
function resolve(id,modeId,d=0){if(d>10)return null;const v=idToVar[id];if(!v)return null;const val=v.valuesByMode[modeId]??Object.values(v.valuesByMode)[0];if(!val)return null;if(val?.type==='VARIABLE_ALIAS')return resolve(val.id,modeId,d+1);if('r'in val)return toHex(val);return null;}
function resolveScalarVal(id,modeId,d=0){let v=idToVar[id];if(!v)return null;let val=v.valuesByMode[modeId]??Object.values(v.valuesByMode)[0];let n=0;while(typeof val==='object'&&val?.type==='VARIABLE_ALIAS'&&n++<10){const a=idToVar[val.id];val=a?.valuesByMode[modeId]??Object.values(a?.valuesByMode??{})[0];}if(val==null)return null;if(typeof val==='number')return (Math.round(val*1000)/1000)+'px';if(typeof val==='boolean')return String(val);if(typeof val==='object'&&'r'in val)return toHex(val);return String(val);}
const sizingOut={};
if(SIZING_COLLECTION){const sc=collections.find(c=>c.name===SIZING_COLLECTION);if(sc){const mid=sc.modes[0].modeId;for(const id of sc.variableIds){const v=idToVar[id];if(!v)continue;sizingOut[v.name]=resolveScalarVal(id,mid)??'';}}}
// modeVariants - DS-agnostic: for every collection in ds-config → figma.collections with ≥2 modes,
// capture the vars that DIFFER across its modes, tagging EACH with its own kind (inferred from
// resolvedType - a single collection may mix color/scalar/string/boolean). Colours of the colour
// collection are skipped here (already in snap.color). Lets Gate [5] check non-colour, per-collection
// mode axes (breakpoint sizing, per-locale strings) AND mixed-type collections (a Theme whose floats
// and booleans also vary light↔dark).
const COLLECTIONS=[]; // from figma.collections, e.g. [{name:'Breakpoint',modes:[{name:'Phone',snapshotKey:'phone'},{name:'Tablet',snapshotKey:'tablet'}]}]
// Auto-capture a multi-mode SIZING collection (e.g. Desktop/Phone). The flat `sizing`
// bucket above keeps only the FIRST mode (base) for the value gate; its OTHER modes
// would otherwise be lost, so capture them here into modeVariants like any per-mode
// axis (base key 'desktop'; other modes slugified, Phone -> 'phone'). Single-mode
// sizing collections are a no-op. The styleguide's [data-size] axis is built from this.
if(SIZING_COLLECTION){const _s=collections.find(c=>c.name===SIZING_COLLECTION);if(_s&&_s.modes.length>=2&&!COLLECTIONS.some(c=>c.name===SIZING_COLLECTION))COLLECTIONS.push({name:SIZING_COLLECTION,modes:_s.modes.map((m,i)=>({name:m.name,snapshotKey:i===0?'desktop':m.name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}))});}
const KIND={COLOR:'color',FLOAT:'scalar',STRING:'string',BOOLEAN:'boolean'};
const modeVariantsOut={};
for(const cc of COLLECTIONS){const c=collections.find(x=>x.name===cc.name);if(!c||c.modes.length<2)continue;const vars={};for(const id of c.variableIds){const v=idToVar[id];if(!v||v.name.startsWith(PRIMITIVE_PREFIX))continue;const kind=KIND[v.resolvedType]||'scalar';if(kind==='color'&&cc.name===COLOR_COLLECTION)continue;const values={};for(const m of cc.modes){const mid=c.modes.find(fm=>fm.name===m.name)?.modeId;if(!mid)continue;values[m.snapshotKey]=kind==='color'?resolve(id,mid):resolveScalarVal(id,mid);}if(new Set(Object.values(values).map(String)).size>1)vars[v.name]={kind,values};}if(Object.keys(vars).length)modeVariantsOut[cc.name]={modes:cc.modes,vars};}
const WEIGHT={'Thin':100,'Extra Light':200,'Light':300,'Regular':400,'Medium':500,'Semi Bold':600,'Bold':700,'Extra Bold':800,'Black':900};
const styles=await figma.getLocalTextStylesAsync(); const typo={};
for(const st of styles){const key=st.name.trim().toLowerCase().split('/').pop();const entry={size:Math.round(st.fontSize*10)/10+'px'};const w=WEIGHT[st.fontName.style];if(w)entry.weight=String(w);if(st.lineHeight?.unit==='PIXELS')entry.lh=Math.round(st.lineHeight.value*10)/10+'px';if(st.letterSpacing?.value)entry.ls=(st.letterSpacing.unit==='PERCENT'?Math.round(st.letterSpacing.value*100)/10000+'em':Math.round(st.letterSpacing.value*100)/100+'px');if(st.textCase&&st.textCase!=='ORIGINAL')entry.textTransform=(st.textCase==='UPPER'?'uppercase':st.textCase==='LOWER'?'lowercase':st.textCase.toLowerCase());typo[key]=entry;}
return {sizing:sizingOut,typography:typo,modeVariants:modeVariantsOut};
```

**Final assembly** (after all calls complete):
```js
{
  color: { light, dark, /* other modes */ },
  aliases: aliasesOut,
  sizing: sizingOut,
  typography: typo,
  modeVariants: modeVariantsOut,   // per-collection, per-mode non-colour maps (optional)
  motion: motionOut,               // easing/duration tokens (optional - Gate: Motion parity)
  effects: effectsOut,             // shadow styles → box-shadow (optional - Gate: Effect parity)
}
```

> The snapshot `color` object has one key per mode (`snapshotKey`), e.g. `{ light: {...}, dark: {...}, "high-contrast": {...} }`.

---


## Phase 1 - Step 1b-motion-effects: motion + effects (optional, opt-in gates)

Only needed if the DS has motion (easing/duration) variables or effect (shadow) styles you want
parity-checked. Both gates are **no-ops unless captured AND declared** in `ds-config.json`
(`figma.motion` / `figma.effects`). Merge `motion` and `effects` into the snapshot object.

```js
const collections=await figma.variables.getLocalVariableCollectionsAsync();
const idToVar={};
for(const col of collections){for(const id of col.variableIds){const v=await figma.variables.getVariableByIdAsync(id);if(v)idToVar[id]=v;}}
// Motion - the Motion collection's variables → CSS-comparable strings. Figma variables are FLOAT
// (durations, read as ms) or STRING (easing curves such as "cubic-bezier(0.4, 0, 0.2, 1)" or "ease-out");
// EASING/TIMING are accepted too in case Figma adds dedicated types. The gate compares 200ms = 0.2s and
// a keyword easing = its curve.
function deref(id,modeId,d=0){let v=idToVar[id];if(!v)return null;let val=v.valuesByMode[modeId]??Object.values(v.valuesByMode)[0];let n=0;while(typeof val==='object'&&val?.type==='VARIABLE_ALIAS'&&n++<10){const a=idToVar[val.id];val=a?.valuesByMode[modeId]??Object.values(a?.valuesByMode??{})[0];}return val;}
function motionStr(val){if(val==null)return null;if(typeof val==='number')return val+'ms';if(typeof val==='string')return val.trim();const b=val.easingFunctionCubicBezier||val.cubicBezier||val.bezier;if(b&&('x1'in b))return `cubic-bezier(${b.x1}, ${b.y1}, ${b.x2}, ${b.y2})`;if('value'in val)return val.value+(val.unit==='MILLISECONDS'||!val.unit?'ms':'');return JSON.stringify(val);}
const MOTION_COLLECTION='Motion'; // fill from figma.motion (or leave and let it match by type)
const motionOut={};
for(const c of collections){if(MOTION_COLLECTION&&c.name!==MOTION_COLLECTION)continue;const mid=c.modes[0].modeId;for(const id of c.variableIds){const v=idToVar[id];if(!v||!['FLOAT','STRING','EASING','TIMING'].includes(v.resolvedType))continue;const s=motionStr(deref(id,mid));if(s!=null)motionOut[v.name]=s;}}
// Effects - local effect styles → canonical box-shadow "x y blur spread color[, …]".
function rgba(c){return `rgba(${Math.round(c.r*255)}, ${Math.round(c.g*255)}, ${Math.round(c.b*255)}, ${+(c.a??1).toFixed(3)})`;}
function effShadow(e){const p=[`${e.offset?.x??0}px`,`${e.offset?.y??0}px`,`${e.radius??0}px`];if(e.spread)p.push(`${e.spread}px`);p.push(rgba(e.color||{r:0,g:0,b:0,a:1}));if(e.type==='INNER_SHADOW')p.push('inset');return p.join(' ');}
const effectsOut={};
for(const st of await figma.getLocalEffectStylesAsync()){const sh=(st.effects||[]).filter(e=>e.type==='DROP_SHADOW'||e.type==='INNER_SHADOW').map(effShadow);if(sh.length)effectsOut[st.name]=sh.join(', ');}
return {motion:motionOut,effects:effectsOut};
```

---


## Phase 1 - Step 1c: Capture component structure → `figma-structure.snapshot.json`

> **HARD RULE - capture, RESOLVE, and BUILD every component. Automatic mode.**
> An unscoped parity run must walk **all** `COMPONENT_SET`/`COMPONENT` nodes on the components
> page and capture the complete Step 1c field set for each - not a quick "signature" (a few
> fields), not only the ones already in the contract, not a sample. The only time you narrow the
> component set is when the user **explicitly** asks for a subset (`--component X`). Skipping
> components, or capturing a thin subset of their fields, is treated as not doing the job: a DS
> redesign (a component that got taller, gained a `Disabled` variant, dropped padding, added a
> border) is invisible to the token/value gates and shows up **only** in a full structural
> capture. A shortcut here is the single most common way real drift ships unaudited.
>
> **Refreshing the *vars* snapshot is NOT a Phase 1 refresh — the structure walk (Step 1c) runs in
> the SAME run, every run.** The tempting shortcut is: capture colours, see they're unchanged, and
> assume the structure is stable too. It is not — height, padding, gap, slot-gap, stroke and
> variant changes are *orthogonal* to colour and live **only** in `figma-structure.snapshot.json`.
> "The tokens didn't move" is never evidence that "the components didn't move" (the exact miss:
> vars unchanged while a divider's top spacing and a panel's slot gap had drifted). When the
> The engine never refreshes these snapshots for you, so **you** run the Step 1c Plugin API walk
> (works on any plan) alongside
> the vars capture — refreshing one and not the other is the failure this rule exists to stop.
> **Set `maxSnapshotAgeDays` in `ds-config.json`** so Gate [1] *hard-fails* on a stale snapshot
> instead of passing green with an advisory — that turns "always refresh" from a discipline you can
> forget into a gate you cannot.
>
> **Ownership gate — resolving and building apply ONLY to a repo you own or were asked to fix.**
> Capturing everything always holds (verification is always complete). But the two rules below
> *mutate the codebase*, so they apply only when the audited repo is **yours / this DS**, or the
> user explicitly asked you to fix or build. When you are merely **verifying a repository someone
> handed you**, switch to *verify-and-report*: run every gate, produce the divergence report + the
> table, and **propose** fixes (or `--fix` for mechanical value divergences) — but do **not** edit
> their code, restructure their DS, move components into the system, or build components, without an
> explicit go-ahead. A divergence in a consumer repo is often **intentional** (a brand override, a
> consumer that deliberately lags the DS, an in-progress migration): surface it and let them decide.
> `figmaSourceKey` (`⏳ PENDING FIGMA SYNC`), `visualRegression.mode: "advisory"` and the exemption
> lists exist precisely to separate "the code is wrong" from "intentional consumer override".
>
> **Resolve, don't defer.** A real difference is sent back the way it goes, in the same run: each one
> says which side moved since the two last agreed (`design-system-engine-agreed.json`), and the
> hand-back holds the code patch and the list of changes to make in Figma. Figma does not always win:
> the side that moved leads, and where neither is known to lead, the person decides. Change the code
> only for what the person asked; report the rest.
>
> **Build, don't park.** `knownUnimplementedComponents` is a temporary hold, and an **empty list
> is the target**: when the person asks, build each listed component (`rms-design-system-engine
> --recipe build-from-figma`), then take it off the list. Every design-system component is built
> once, in the system's own files (its token CSS and component files), never redefined inside a
> screen or a feature. A component's size or identity pinned in a screen's own styles is a smell:
> move it to the system and leave only that screen's layout behind.

Navigate to your DS Components page, find each `COMPONENT_SET`, navigate to the `State=Default` child (never the SET - its height equals all variants stacked), and extract structural facts:

```js
// Extract: h, paddingVar {tb,lr}, gapVar, fontSizeVar, fontWeightVar,
//          fillStructure ('direct' | 'before' | 'none'), innerRadiusVar,
//          strokeOnDefault, strokeOnAnyState, childFramePadding, childFrameGaps
// fillStructure = 'before' when fill is on a child "Background" rect (→ CSS ::before)
//                 'direct' when on the frame itself
//                 'none' when default state has no fill (fills === [] - an empty array is a real
//                 DS fact, not a capture miss; figma.mixed must be treated as no-fill too)
// fontSizeVar/fontWeightVar = bound fontSize/fontWeight variable name on the component's
//                 primary (first, depth-first) TEXT node. When unbound, fall back to the
//                 applied text style's scale key (last path segment, lowercased) for BOTH
//                 fields - a text style carries size AND weight, so recording one of the
//                 pair as null while a style is applied is a capture bug, not a DS fact.
//                 null only when the component has no TEXT node or the text has no style.
// innerRadiusVar = first bound radius variable (topLeftRadius → cornerRadius → other corners)
//                 checked on the State=Default frame ITSELF first, THEN on a child named
//                 *Background*. Radius commonly sits on the frame for 'direct'/'none' fills
//                 and on the Background rect for 'before' fills - checking only one location
//                 produces false nulls.
// strokeOnDefault  = node.strokes?.length > 0 on the State=Default variant's top-level frame
// strokeOnAnyState = true if a stroke exists ANYWHERE in ANY variant's subtree (deep walk).
//                    Must walk recursively into children - many components put strokes on a
//                    "Background" child rect rather than the component frame itself.
//                    Controls Gate [3c] phantom border scan - when false, any CSS `border`
//                    or `outline` on any selector matching this component is a phantom and fails.
// childFramePadding = direct child FRAME nodes (not RECTANGLE/TEXT/INSTANCE) that have at
//                    least one bound padding variable. These "wrapper frames" (e.g. LabelContainer)
//                    add inner padding on top of the outer component padding. The CSS must account
//                    for them via padding on the matching HTML child element (e.g. span, .label).
//                    Omit if no child frames have bound padding.
// childFrameGaps   = direct child FRAME nodes with a bound itemSpacing variable:
//                    [{ name, gapVar }]. Root-level gapVar cannot see these - a DS rebind on an
//                    inner frame (e.g. toast "content" gap/s → gap/m) is invisible without them.
//                    Gate [3] cross-checks every entry against CONTRACT[comp].children: an
//                    uncontracted snapshot entry or a gapVar mismatch is a failure, and a
//                    contracted gapVar whose frame no longer binds a gap in Figma is stale.
//                    Omit if no child frames have bound gaps.
```

**Deeper facts (recommended).** Also record these on each component's entry, from the same
`State=Default` node. The measured comparison (Gate [10] `MEASURED`, `--capture-code --compare`) uses
each one when present:
- sizing per axis, a fixed width, and min and max width
- the gap, the stroke width on each side, and opacity
- the text node's family, line height (px, % or auto), letter spacing and text case
- the fill, text and stroke colour tokens with their paint opacity, compared in every mode
- one entry per variant (height, padding, gap, radius, font size, colours, visible layers); only what a
  variant changes from the default is compared, against the state the code capture produced. A variant
  that changes two or more axes (Size=L with Icon=True) is produced by putting each axis's propertyMap
  selector on at once (up to `codeReading.maxCombinations`, default 12, per component). Visible layers are
  compared by name with the contract's `children` that have a `name` and a `cssSelector`
- which layers each boolean property shows or hides (`toggles`)
- each slot's preferred components (`slots`), which the contract uses as the slot's `accepts` list

Snapshots without them keep working; the comparison simply skips what Figma did not record.

**Each component against its Figma image.** With `codeReading.visual: true` the capture also saves each
component as the page draws it (first mode, default state, scale 2) under `.design-system-engine-out/visual/code/`, and
Gate [13] compares it with the Figma image of the component's default variant. The Figma image comes from
`.design-system-engine-refs/components/<name>.png` when you saved one (exported from Figma at 2x), else from the Figma REST
API with `FIGMA_TOKEN` (cached under `.design-system-engine-out/visual/figma/` until the file version changes). A component
with neither is listed as not compared. Two percentages per component, worst first: the pixels that differ,
and the pixels that differ outside its text, since two renderers never draw glyphs the same way. The second
decides the ⚠️. A diff image per component, differing pixels in red, goes to `.design-system-engine-out/visual/diff/`. It
catches what no single field shows, such as a border, an icon on the other side or a wrong glyph. Advisory.

**What was checked.** Under MEASURED, one `census` line says how many facts were compared, how many were not
comparable, and which components were not captured, followed by the components with the most facts not
comparable and their main reason. A clean result is only as good as its reach. The full table per component
is written to `.design-system-engine-out/census.json`.

**Disabled wins.** For every component with a disabled state, the capture also puts `:hover` and `:active` on the
disabled instance. Any visible change against disabled alone (text colour, background, border colour, opacity)
is listed under MEASURED as `hover while disabled`: the hover or press style lacks a `:not(:disabled)` guard.
A state the user cannot reach is not listed: no hover when the disabled state has `pointer-events: none`, and no
press on a natively disabled control.
Combinations such as selected with hover are compared whenever Figma has that variant (see below).

With `variants` recorded, Gate [13] also lists each Figma variant value (an axis value such as
`Size=L`) that has no counterpart in code (`⚠️ VARIANTS`): not the default, not a state the code
capture produced, and not one it found declared. When the variables snapshot has a breakpoint
collection, the code capture measures each component at every breakpoint width (the smallest mode at
375px) and compares the tokens that change per breakpoint (`padding (left) @ Phone (375px)`).

```js
async function deepFacts(node, set) {
  const n = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : null);
  const hex = (c) => '#' + [c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
  // A visible solid paint: its bound colour variable's name, its hex and the paint's opacity.
  const paint = async (paints) => {
    const p = (Array.isArray(paints) ? paints : []).find((x) => x.visible !== false && x.type === 'SOLID');
    if (!p) return null;
    const id = p.boundVariables?.color?.id;
    const v = id ? await figma.variables.getVariableByIdAsync(id) : null;
    return { token: v?.name ?? null, hex: hex(p.color), opacity: n(p.opacity ?? 1) };
  };
  const firstText = (x) => x.findOne?.((t) => t.type === 'TEXT');
  const geometry = async (x) => {
    const t = firstText(x);
    return {
      h: n(x.height),
      paddingPx: 'paddingTop' in x ? [x.paddingTop, x.paddingRight, x.paddingBottom, x.paddingLeft].map(n) : null,
      gapPx: 'itemSpacing' in x ? n(x.itemSpacing) : null,
      radiusPx: 'topLeftRadius' in x ? [x.topLeftRadius, x.topRightRadius, x.bottomRightRadius, x.bottomLeftRadius].map(n) : null,
      fontSize: t && t.fontSize !== figma.mixed ? n(t.fontSize) : null,
      colors: { fill: await paint(x.fills), text: t ? await paint(t.fills) : null, stroke: await paint(x.strokes) },
      layers: visibleLayers(x),
    };
  };
  // Names of the layers actually shown (a layer inside a hidden one is not), at most 80.
  function visibleLayers(x) {
    const names = new Set();
    const walk = (n) => { for (const c of n.children ?? []) { if (c.visible === false || names.size >= 80) continue; names.add(c.name); walk(c); } };
    walk(x);
    return [...names];
  }
  const out = {};
  if ('layoutMode' in node) out.box = { width: n(node.width), height: n(node.height), layout: node.layoutMode,
    sizing: { h: node.layoutSizingHorizontal, v: node.layoutSizingVertical },
    minWidth: n(node.minWidth), maxWidth: n(node.maxWidth),
    align: { primary: node.primaryAxisAlignItems, counter: node.counterAxisAlignItems }, wrap: node.layoutWrap };
  const g = await geometry(node);
  out.paddingPx = g.paddingPx; out.radiusPx = g.radiusPx; out.gapPx = g.gapPx; out.colors = g.colors;
  if ((node.strokes ?? []).some((s) => s.visible !== false)) out.stroke = {
    weights: ['strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight'].map((k) => n(typeof node[k] === 'number' ? node[k] : node.strokeWeight)),
    align: node.strokeAlign, dashed: (node.dashPattern ?? []).length > 0 };
  if (typeof node.opacity === 'number' && node.opacity < 1) out.opacity = n(node.opacity);
  const text = firstText(node);
  if (text) {
    const lh = text.lineHeight, ls = text.letterSpacing, fn = text.fontName;
    out.text = {
      fontFamily: fn && fn !== figma.mixed ? fn.family : null,
      lineHeight: lh && lh !== figma.mixed ? (lh.unit === 'AUTO' ? { unit: 'AUTO' } : { unit: lh.unit, value: n(lh.value) }) : null,
      letterSpacing: ls && ls !== figma.mixed ? { unit: ls.unit, value: n(ls.value) } : null,
      textCase: text.textCase !== figma.mixed ? text.textCase : null,
    };
  }
  // Which layers each boolean property shows or hides.
  const toggles = {};
  for (const l of node.findAll?.((x) => x.componentPropertyReferences?.visible) ?? []) {
    const prop = l.componentPropertyReferences.visible.replace(/#.*$/, '');
    (toggles[prop] ??= []).push(l.name);
  }
  if (Object.keys(toggles).length) out.toggles = toggles;
  if (set?.type === 'COMPONENT_SET') {
    out.defaultVariant = node.name;
    out.variants = {};
    for (const v of set.children.filter((c) => c.type === 'COMPONENT')) out.variants[v.name] = await geometry(v);
    // Each slot's preferred components, by name (the definitions only carry keys).
    const byKey = new Map(figma.root.findAll((x) => (x.type === 'COMPONENT' || x.type === 'COMPONENT_SET') && x.key).map((x) => [x.key, x.name]));
    const slots = {};
    for (const [k, d] of Object.entries(set.componentPropertyDefinitions ?? {})) {
      if (d.type !== 'INSTANCE_SWAP' || !d.preferredValues?.length) continue;
      slots[k.replace(/#.*$/, '')] = d.preferredValues.map((p) => byKey.get(p.key)).filter(Boolean);
    }
    if (Object.keys(slots).length) out.slots = slots;
  }
  return out;
}
// entry = { h, paddingVar, …, ...(await deepFacts(defaultVariant, componentSet)) }
```

Capture `strokeOnAnyState` with a **deep recursive walk** across all variants:

```js
function deepHasStroke(node, depth = 0) {
  if ((node.strokes?.length ?? 0) > 0) return true;
  if (depth < 4 && 'children' in node) {
    return node.children.some(c => deepHasStroke(c, depth + 1));
  }
  return false;
}
// Walk ALL variants of the COMPONENT_SET, not just the default:
const strokeOnAnyState = set.children.some(v => deepHasStroke(v));
```

**Also capture the *resting* variant's root stroke** - `restingStroke` + `restingState`.
The single-variant `/default/i` capture is blind to a newly-added resting state: if the
DS inserts a borderless "Idle" variant before the bordered "Default", `strokeOnDefault`
still reports the old bordered state and nothing notices the resting appearance changed
(this is the node "idle border" miss). The *resting* variant is the pure at-rest one:
first `State=` value, with `Disabled=False` and `Selected=False` where those axes exist.

```js
function parseAxes(name){const o={};for(const p of name.split(',')){const i=p.indexOf('=');if(i>=0)o[p.slice(0,i).trim().toLowerCase()]=p.slice(i+1).trim().toLowerCase();}return o;}
const variants = set.children.filter(c => c.type === 'COMPONENT');
const firstAxes = parseAxes(variants[0].name);
const stateKey  = 'state' in firstAxes ? 'state' : Object.keys(firstAxes)[0];
const firstState = firstAxes[stateKey];
const resting = variants.find(v => {
  const a = parseAxes(v.name);
  if (a[stateKey] !== firstState) return false;
  if ('disabled' in a && a.disabled !== 'false') return false;
  if ('selected' in a && a.selected !== 'false') return false;
  return true;
}) ?? variants[0];
const restingState  = firstState;
const restingStroke = (resting.strokes ?? []).filter(s => s.visible !== false).length > 0;
```

`restingStroke` records the resting variant's **root** stroke, so a Phase-1 diff surfaces
"resting state changed" when the DS adds/removes a resting border. To turn that visibility
into an enforced lock, add `restingStroke: false` (+ `restingState`) to the component's
CONTRACT entry when the resting state is borderless - **Gate [3l]** then requires the bare
component selector's border to be `transparent`/`none`, so a colored resting border can
never regress in. It's opt-in per component (a `false` in the contract) because many DS
components model their border on a child rect while the root variant has no stroke, so an
auto-derived "must have a border" rule would false-positive.

**Gate [3b] - border sides must match Figma, and are mandatory when a stroke exists.**
A component's `strokeSides` pins which CSS border sides may be drawn: `'all'` requires the
`border:` shorthand; a single side (`'top'`/`'right'`/`'bottom'`/`'left'`) requires
`border-<side>` and forbids the shorthand; `'none'` documents a component that draws no border
of its own - its stroke flag comes from a *nested* sub-component or a consumer wrapper (e.g.
`sectionHeader`'s nested `buttonSecondary`), so the CSS side assertion is skipped. Crucially,
`strokeSides` is **mandatory whenever Figma draws any stroke** -
`strokeOnDefault` OR `strokeOnAnyState`. A strokeful component that omits it **fails** Gate [3b]
rather than being silently skipped (the hole that let `.moreMenu` ship a 4-sided `border:`
when its DS Background rect strokes bottom-only). To confirm the sides, read the DS component's
per-side `strokeTopWeight`/`strokeBottomWeight`/… via the Plugin API - bound `strokeBottomWeight`
with the other sides at 0 means `border-bottom` only. Park a not-yet-verified strokeful component
in `ds-config.json → knownUndeclaredStrokeSides` (tech-debt, not an exemption: declare the real
sides and remove it as each is checked).

**Gate [3m] - fixed-height components that can shrink (advisory).** A component whose snapshot `h`
is a fixed number renders that exact height in Figma, but in code it's often a flex-column
child (a list row); a flex child with `height:Npx` and no `flex-shrink:0` compresses when
the container runs short (the menuList/node/toast/moreMenu shrinking bug). Gate [3m]
warns when a fixed-height component whose base rule pins the height has no
`flex-shrink:0`. It is a risk in how the component is placed, not a difference from Figma,
so it never fails the gate. Exempt a genuinely-never-flex component via
`ds-config.json → knownShrinkExceptions`.

**Icon-size capture (Gate [16] `iconSizeOf`).** In Step 1c, also record each component's
primary icon box as `iconSize` (the DS uses one icon size, typically 16px). A rendered
assertion tagged `iconSizeOf: '<component>'` then sources its expected width/height from the
snapshot - so an icon that's silently too small (the 12px search icon) fails, and the check
auto-updates if the DS resizes.

**Frame-geometry capture (Gate [16] `frameGeom`).** Component checks verify a component's
*own* box but miss *context* - spacing between elements, container padding. `figma-frame-geometry.snapshot.json`
(`{ node: { h, pad:[t,r,b,l], gap } }`, keyed by node name, array + `_path` when a name repeats)
is **auto-refreshed every run** via `refreshFrameGeometry` (REST `/nodes` - works on any plan,
on any plan) and Gate [1] tracks its freshness. A rendered assertion tagged
`frameGeom: { node, path? }` sources its expected padding/gap/height from that node, so
container-spacing checks track the live frame - the class that missed the 7px `.view-toggle-row`
bottom padding above the first divider.

**`FRAME_GEOMETRY_MAP` - element-geometry auto-expand (Gate [16]).** Map a selector to a DS
frame node once - `{ plugin, selector, node, path?, props? }` - and rendered-check expands it
into one `frameGeom` assertion per `prop` (default: the four padding sides). Mapping a container
once auto-checks all its box geometry against the live frame; no per-prop hand-authoring.

**Text-style capture (Gate [16] `textStyle`).** A static CSS scan can't see that an element
*renders* the wrong type: a rule can set `font-size` from the right token yet inherit a heavier
`font-weight` from a container (the checkbox label that inherited the `s` weight 700 while the DS
uses style `m`, 600) - every token value is individually correct, so gates [3]/[8] stay green. An
assertion tagged `textStyle: '<name>'` sources the expected `font-size`/`font-weight`/`line-height`
from that named DS text style in the **typography snapshot** (`figma-vars.snapshot.json → typography`,
e.g. `m: { size, weight, lh }`) and expands into one computed-style assertion per facet (a tier with
no line-height - an auto-leading style - omits that one). Point it at the **real** selector, not a
`probe`, so the element is measured inside its actual container and the inheritance is what gets
checked. Opt-in per assertion, so it never false-positives on rules that correctly inherit. Rule of
thumb: every text element that maps to a DS named style should carry a `textStyle` assertion -
matching size/weight/line-height by hand silently drifts and drops line-height.

**Cross-plugin consistency (`CROSS_PLUGIN_CONSISTENCY`, Gate [16]).** A `theme.css` base
component must compute the same values in every plugin that uses it. Each entry -
`{ label, selector, probe, props, plugins }` - renders the probe in every listed plugin and
asserts they all agree on every prop, catching a plugin-local rule that silently overrides a
shared component (e.g. dropping `flex-shrink` or changing a height on `.menuList`).

**Multi-variant capture + Gate [3n]/[3o].** The snapshot records **every** variant's facts, not
just the single `/default/i` one: `variantStroke` (per-variant root stroke) and `variantHeight`
(per-variant height). **Gate [3n]** - a set with both a bordered and a borderless variant (the
shape that hid node's new "Idle" state) must declare `restingStroke`, which activates Gate [3l]
to lock the base border. **Gate [3o]** - a set whose variants have different heights (e.g. toast
loading=48/success=32) must cover each non-base height in the contract's `states` map, so a new
height-varying state can't render against the wrong height. Uniform components pass automatically.

**Visual-regression advisory mode (Gate [2] de-noise).** The pixel screenshot compares the LIVE
DS frame to a stored PNG - so a change means the *designer edited the frame*, not that the code
regressed (structural code↔DS geometry is the `frameGeom` checks' job). Set `ds-config.json →
visualRegression.mode: "advisory"` and a changed frame **auto-updates the baseline** (the PNG diff
stays git-visible for review) and reports it, instead of blocking the audit. Default stays
`blocking` for backward compatibility.

**DS orphan-token report (`bound-check`).** An orphan = a token in the DS variable snapshot bound
to **nothing** - not to a frame node (`bound-tokens.json`) nor a component variant
(`component-state-tokens.json`). Two tiers: **orphan-but-used** (⚠️ / ❌ under
`orphanUsedStrict`) - the code declares its CSS var, so the DS abandoned a token the code still
styles with (the `node/border/default` class); and **orphan** (ℹ️) - unused on both sides, a DS
cleanup candidate. Advisory by default because the "bound" set can't always distinguish a stale
token from a legit interaction state with no variant (focus, selected+hover); triage confirmed
ones into `ds-config.json → knownOrphanExceptions`.

```js
// Frame-geometry capture - run per DS layout frame, save to figma-frame-geometry.snapshot.json
const nodes = {};
(function rec(n, path) {
  if (n.type === 'FRAME' || n.type === 'INSTANCE' || n.type === 'COMPONENT') {
    (nodes[n.name] ??= []).push({
      _path: path,
      h: Math.round(n.height),
      pad: 'paddingTop' in n ? [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft] : null,
      gap: n.itemSpacing ?? null,
    });
  }
  if ('children' in n) for (const c of n.children) rec(c, path + '/' + n.name);
})(frameNode, '');
// De-dupe identical entries per name; keep _path only where a name repeats.
```

> **`paddingVar.tb` collapses two sides that can genuinely differ.** The field records one
> variable for top *and* bottom, taken from `paddingTop` first. A component padded
> `padding/l` on top and `padding/xs` on the bottom therefore snapshots as if both were
> `padding/l`, and the contract copies that fiction. The height still reconciles (it is
> measured, not derived), so nothing fails - the asymmetry is simply invisible.
>
> Until the field is split, spell both sides out in the CSS shorthand and add a contract
> comment naming the real top/bottom tokens, so the next person reading `tb` does not
> "correct" the CSS to match it. When a component's `h` cannot be explained by
> `tb + content + tb`, suspect this first.

Capture `childFramePadding` by walking direct FRAME children of the State=Default variant:

```js
function getBoundPaddingVar(node, idToVar) {
  const bv = node.boundVariables ?? {};
  const res = (id) => id ? idToVar[id]?.name ?? null : null;
  const lr = res(bv.paddingLeft?.id ?? bv.paddingRight?.id);
  const tb = res(bv.paddingTop?.id ?? bv.paddingBottom?.id);
  return (lr || tb) ? { tb: tb ?? null, lr: lr ?? null } : null;
}
const childFramePadding = [], childFrameGaps = [];
for (const child of defaultVariant.children ?? []) {
  // FRAME **and SLOT**: a slotted component (panel, toolbar, moreMenu, modal, …) keeps its
  // content in a `SLOT` node, and its `itemSpacing` is the gap the DS puts between the slotted
  // items. Skipping non-FRAME children (the old `!== 'FRAME'`) made every slot gap invisible - the
  // panel's `Content` slot gap (gap/xl) never entered the snapshot, so parity could never see it
  // drift. Capture layout containers regardless of whether they are a FRAME or a SLOT.
  if (child.type !== 'FRAME' && child.type !== 'SLOT') continue;
  const pv = getBoundPaddingVar(child, idToVar);
  if (pv) childFramePadding.push({ name: child.name, paddingVar: pv });
  const gapId = child.boundVariables?.itemSpacing?.id;
  const gv = gapId ? idToVar[gapId]?.name ?? null : null;
  // A token-bound gap is always recorded. An UNBOUND gap (no variable) is recorded too, but only
  // for an auto-layout frame with ≥2 children — where a gap is actually meaningful — as
  // { gapVar: null, gapPx }. This makes a flush (gap 0) or raw-px inner frame visible so a
  // `children` entry can pin it with `gapPx` and a Phase-1 diff catches a DS change to it.
  const isAutoLayout = child.layoutMode && child.layoutMode !== 'NONE';
  const gapPx = typeof child.itemSpacing === 'number' ? child.itemSpacing : null;
  if (gv) childFrameGaps.push({ name: child.name, gapVar: gv, gapPx });
  else if (isAutoLayout && gapPx !== null && (child.children?.length ?? 0) >= 2)
    childFrameGaps.push({ name: child.name, gapVar: null, gapPx });
}
// Include childFramePadding / childFrameGaps in snapshot only when non-empty
```

Write the result in this shape:
```json
{
  "_updated": "YYYY-MM-DD",
  "_note": "Auto-generated by /rms-design-system-engine. Do not edit manually.",
  "components": {
    "button": {
      "h": 32,
      "paddingVar": { "tb": "padding/s", "lr": "padding/m" },
      "gapVar": "gap/s",
      "strokeOnDefault": false,
      "strokeOnAnyState": false
    },
    "buttonTertiary": {
      "h": 24,
      "paddingVar": { "tb": null, "lr": "padding/xs" },
      "strokeOnDefault": false,
      "strokeOnAnyState": false,
      "childFramePadding": [
        { "name": "LabelContainer", "paddingVar": { "tb": null, "lr": "padding/xs" } }
      ]
    },
    "toast": {
      "h": 48,
      "paddingVar": { "tb": "padding/s", "lr": "padding/m" },
      "gapVar": "gap/xl",
      "childFrameGaps": [
        { "name": "content", "gapVar": "gap/m" }
      ]
    }
  }
}
```

**`childFramePadding` → CSS rule required.** Each entry is a Figma wrapper frame that adds padding inside the component, stacking on top of the outer frame's padding. The CSS must apply equivalent padding to the matching HTML child element. When you find a `childFramePadding` entry:

1. **Identify the HTML equivalent** - determine which element in the rendered HTML corresponds to the Figma child frame (e.g. `LabelContainer` → `<span>` inside `.buttonTertiary`).
2. **Verify or add a CSS rule** - grep for `.<component> <element> { padding`. If none exists, the padding layer is missing from the implementation - add it.
3. **Document in `structure-contract.mjs`** so Gate [3] enforces it automatically:
   ```js
   buttonTertiary: {
     // ...other fields...
     childFramePadding: [
       { name: 'LabelContainer', cssSelector: '.buttonTertiary span', paddingVar: { tb: null, lr: 'padding/xs' } }
     ],
   }
   ```

**`childFrameGaps` → contracted `children` entry required.** Same idea for inner-frame gaps: every snapshot `childFrameGaps` entry must have a matching `children: [{ name, cssSelector, gapVar }]` entry in `structure-contract.mjs`. Gate [3] fails on an uncontracted snapshot entry, a `gapVar` mismatch (contract stale vs Figma), or a contracted `gapVar` whose frame no longer binds a gap in Figma. Set `cssSelector: null` when the child frame is flattened in the HTML (its gap/padding is expressed on the root rule or geometrically) - the CSS lookup in Gate [3f] is skipped, but the snapshot cross-check still runs, so a DS rebind is always caught. Document the flattening in a comment next to the entry.

> **A `cssSelector: null` slot that carries a PADDING token must declare `verifiedBy`, or Gate [3f] fails.** `cssSelector: null` skips the code lookup — which is correct for a gap (a slot's gap spaces whatever is slotted in *per-context*, so there is no one fixed value to assert) but **dangerous for a padding token**: a slot's own inset is a real value the code must reproduce, and skipping it silently is exactly how a slot's top/side padding drifts unseen. Real case: the DS `panel` was restructured into `HeadContent`/`MainContent` slots; `HeadContent` carried `top padding/l` (16), the base `.drawerHeader` shipped `padding/s` (8), and **every gate stayed green** because the slot was marked documentary. So the engine now **refuses** a null-selector slot with a `paddingVar.tb`/`paddingVar.lr` unless it names what checks that padding, via a **`verifiedBy`** string — a real selector, a `RENDERED_ASSERTIONS` reference (pin the exact per-side px there — a slot's padding is often asymmetric, e.g. top `padding/l` + bottom `padding/s`, which the single `{tb}` field can't express), or `'geometric …'` when a fixed height/`::before` inset absorbs it. No `verifiedBy` ⇒ **Gate [3f] FAIL** naming the slot and the unverified token. This is what turns "the DS defines a slot inset" from a silent skip into a tracked, reviewed exemption — the generic guard, not one hand-written assertion per slot.

**Unbound / flush inner gaps (`gapPx`).** A `gapVar` only exists when the DS binds the inner
frame's spacing to a *token*. A frame whose children sit **flush** (auto-layout gap 0) or use a
raw px gap has no token, so it never appeared in `childFrameGaps` and nothing stopped the code
from adding a stray gap there - the label-to-icon gap on the switch's Content frame (DS 0, code
`gap/xs`) drifted for exactly this reason. Two parts close it:
- **Capture** records auto-layout child frames with an unbound gap too, as
  `{ name, gapVar: null, gapPx: <number> }` (including `gapPx: 0`), so the value is visible and a
  Phase-1 diff surfaces a DS change to it.
- **Contract** a `children` entry may pin the raw value with `gapPx` instead of `gapVar`:
  `{ name: 'Content', cssSelector: '.switch-body', gapPx: 0 }`. Gate [3f] then asserts the CSS
  `gap` equals that literal (`0`/`0px`, or `<n>px`), and the snapshot cross-check flags a DS-side
  change to a contracted `gapPx`. To avoid flooding the contract, an **uncontracted** unbound gap
  is *not* a failure (unlike an uncontracted token gap) - it is only enforced once you opt in with
  a `gapPx` entry. Use it whenever "the DS keeps these flush" is a real constraint.

**Root gaps are covered too, and a `findBlock` blind spot is closed.** A component's OWN root gap
can also be flush/raw (not just child frames) — every DS button root is `HORIZONTAL` with
`rootGap 0`, the label↔icon spacing coming entirely from the LabelContainer padding. A contract
entry pins it with a top-level `gapPx` (alongside `gapVar: null`): `{ …, gapVar: null, gapPx: 0 }`,
enforced against the component's `COMPONENT_CSS_SELECTORS.main` gap (or via a `CSS_PROPERTY_ASSERTIONS`
`{ prop:'gap', expected:'0' }` for a selector the block index mis-resolves). This is exactly how all
four buttons drifted (code added `gap/s` on top of the span padding, doubling the label↔icon gap)
with no gate catching it. Two reasons it was invisible: the child-frame gapPx check only walks
children, and — the deeper one — `buildBlockIndex` kept the **last** rule seen for a selector, so a
bare-selector override nested in `@media (dark)` (e.g. `.buttonTertiary { color }`) clobbered the full
base rule and left its geometry (height/padding/gap/radius) silently unchecked. The index now keeps
the **fullest** block per selector, so the base rule always wins and any component with a dark-mode
bare override is checkable again.

### Capture robustness — Phase-1 lessons

The audit compares code against the committed snapshots, so a lossy or stale capture is invisible
until it produces a wrong result. These rules keep Phase 1 honest — they are capture-time (agent /
Plugin API) discipline, not gates, because a tokenless plan has no live Figma access from the engine:

- **Never dismiss an anomaly — investigate it to the root, never give up.** When a captured value
  looks *wrong* (the geometry doesn't add up — a group is 63px tall yet its slot reports a 32px gap;
  a value smells like a "placeholder default"; a height jumped), that mismatch is a *lead*, not
  permission to shrug it off as noise and move on. Dismissing it ("ambiguous — I won't touch it")
  is how a **real** divergence ships unaudited: the 32px WAS the DS spec — the slot was laid out
  **horizontally**, so the two items sit side-by-side in one 40px row, and the "impossible" 32px was
  the real gap between them. The rule: when a value confuses you, **drill into the actual node
  structure** (walk the slot's children, their layout axis, sizes and positions) until the value is
  *explained*. Only after you can say exactly what it is may you decide it's correct, drifted, or a
  true placeholder — and if the geometry still doesn't reconcile, keep going, don't stop at "ambiguous".
- **A slot's spacing lives on the SLOT node — capture its gap AND its top/bottom/side padding, not
  only a FRAME's.** A slotted component (panel, toolbar, moreMenu, group) puts its content in a
  `SLOT`, and both its `itemSpacing` and its `padding*` are DS specs the code must match. The
  content-container padding is a frequent silent miss: a panel's Content slot is `padding/l` (16) on
  every side, but the code's scroll/content wrapper is easily left at `top:0` (relying on a child's
  old padding that a DS redesign since removed — e.g. a compact divider that dropped its top padding),
  and no value gate sees it because the padding is on a bespoke per-plugin wrapper, not a base class.
  Capture the SLOT's gap and padding in Step 1c, and contract the code wrapper that realises the slot
  so Gate [3]/[16] assert its padding — top and bottom included.

- **A slot's BACKGROUND FILL is a spec too — a header/sticky slot the DS fills must be OPAQUE in code,
  verified per mode.** When a `SLOT` (or the frame realising it) carries a solid `fills` paint — a
  panel's `HeadContent` header slot filled with the panel surface (`elevationMedium`/`elevationLow`) is
  the canonical case — that fill exists to *occlude* whatever sits behind the slot. A sticky header,
  column-header row, or the gap between a segmented control and the first section divider that is left
  **transparent** in code lets scrolling list items, connector lines and nodes bleed through the top
  strip, even though every token value is correct — no value/structure gate sees a missing background,
  because "transparent" is not a wrong *token*, it is a missing *paint*. So: in Step 1c capture the
  slot's fill (`fills[0]` bound-var name / hex), and for any slot the DS fills that the code realises as
  a **sticky/overlapping header**, add a `RENDERED_ASSERTIONS` `backgroundColor` check that the code
  element computes the panel surface (NOT `rgba(0,0,0,0)`) — **both modes**, since the surface differs
  light/dark. The real miss this exists to stop: an app's graph column-header row and its
  list-view `.view-toggle-row`→first-divider gap were transparent, so content showed through the top;
  the DS `HeadContent` slot had a full background fill the code never reproduced. Reach for this rule
  the moment a slot's `fillStructure` is not `'none'` and the code pins that slot at `top:0`.

- **A DS SCREEN composed of repeated component instances must be reproduced as those instances — a
  bespoke flat view is where per-group spacing drifts unseen.** The component gates verify a component
  in isolation; they do NOT verify that a *screen* the DS assembles out of N instances of that component
  is assembled the same way in code. The canonical miss: an app's detail view is, in the DS, a
  **stack of independent `panel` instances — one per list group**, each carrying its own `HeadContent` (padding/l top, padding/s bottom) over
  `MainContent` (gap/xl). The code hand-built it as one flat scroll-region with sticky dividers, so the
  per-group spacing had *no home* — every group's top/bottom padding and the gap/xl between groups were
  hand-approximated and kept drifting, and no gate could see it because there was no per-group panel to
  contract against. When Step 1c / the screen capture shows a screen repeating a container component per
  data group, **the fix is structural: reproduce each group as that component** (so the component's own
  contract/assertions apply per group), OR — when the code must stay bespoke — pin each group's slot
  spacing explicitly with `RENDERED_ASSERTIONS` (e.g. every group header's `marginTop`/`marginBottom` =
  the `HeadContent` padding) so a regression to flat fails. The tell: a screen where the same header +
  body pattern repeats per section, but the code has one container instead of one-per-section.

- **Stored `nodeId`s go stale — resolve by name+resting variant, not the saved id.** When the DS is
  reorganised, a snapshot's stored variant `nodeId` can resolve to a *different* node (often the whole
  `COMPONENT_SET`), so measuring it yields the set's stacked height and flipped strokes — noise that
  reads as drift. On every structure refresh, re-resolve each component by **set name**, pick the
  **resting variant** (first `State=` value with `Disabled=False`/`Selected=False`), and validate that
  each stored `nodeId` still resolves to a node whose name matches the component — a mismatch is the
  signal the DS was restructured, and the `nodeId`s must be re-captured.
- **Height-match to tell real drift from a mis-measured variant.** Before recording a height change,
  check whether *any* variant still has the old height. If one does, the geometry did not change — you
  measured the wrong variant (the classic `toast` success-vs-loading, or a `min-height` bar that grew
  to hug wrapped content). Only "no variant has the old height" is real drift.
- **Capture icon path data via the Plugin API so freshness works tokenless.** Gate [16]'s live
  path/name freshness needs `FIGMA_TOKEN`; on a plan without one, capture each icon's vector path in
  Phase 1 (Plugin API, any plan) into `figma-icons.snapshot.json`, so Gate [16] still compares the
  snapshot against the code. Also diff the **live DS icon set** against the snapshot to surface added
  icons (a DS may carry more icons than the code uses — those are unused, not missing).
- **A height change touches the contract AND the snapshot together.** Gate [3a] compares `contract.h`
  to `snapshot.h`, so refreshing one without the other fails. For a component that hugs its content,
  prefer `sizing: 'hug'` (see the structure-contract section) over chasing the ±1px re-measure through
  both files.

---


## Phase 1 - Step 1d: Capture effect styles → `effects` key in snapshot

Run this after Step 1b. Effect styles (drop shadow, inner shadow, blur) are captured into a top-level `"effects"` key in `figma-vars.snapshot.json`. Once populated, Gate [19] (`effect-check.mjs`) compares each style against its CSS var. Both capture shapes on this page are accepted: this structured array, and the canonical string from Step 1b-motion-effects.

```js
// Effect styles capture - always safe (effect list is always small)
const effectStyles=await figma.getLocalEffectStylesAsync();
const effects={};
function toHex(c){const h=[c.r,c.g,c.b].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');const a=c.a===undefined?1:c.a;return '#'+h+(a>=1?'':Math.round(a*255).toString(16).padStart(2,'0'));}
for(const es of effectStyles){
  const efx=es.effects.filter(e=>e.visible!==false);
  if(!efx.length)continue;
  effects[es.name]=efx.map(e=>{
    if(e.type==='DROP_SHADOW'||e.type==='INNER_SHADOW'){
      const c=e.color;
      return{type:e.type.toLowerCase().replace('_','-'),x:e.offset.x,y:e.offset.y,blur:e.radius,spread:e.spread??0,color:toHex(c),opacity:Math.round(c.a*100)/100};
    }
    if(e.type==='LAYER_BLUR'||e.type==='BACKGROUND_BLUR')return{type:e.type.toLowerCase().replace('_','-'),blur:e.radius};
    return null;
  }).filter(Boolean);
}
return {effects};
```

Merge the returned `effects` into `figma-vars.snapshot.json` alongside `color`/`sizing`/`typography`. If the DS has no effect styles yet, `effects` will be `{}` - store it anyway so the key exists.

---


## Phase 1 - Step 2: Read the snapshots

Read both snapshot files. Parse them. If either is missing, treat all live values as new and skip to Step 4.

---


## Phase 1 - Step 3: Diff

Compare live vs snapshot across all sections: `color` (all modes), `sizing`, `typography`, `structure`.

**Lead with the name-set diff** before comparing values - print these two lines first:
```
Token names added   (+N): foo/background/hover/color, …
Token names removed (−N): foo/background/color, …
```
A rename shows as both added and removed. A pure addition shows only as added. This makes renames and new state tokens visible even when no values change.

**Changed tokens** → ⚠️ value changed
**New tokens** → 🆕 needs CSS var (Hard Rule #1)
**Removed tokens** → 🗑 check if CSS var can be removed:
  - If the CSS var is **unused** (no CSS rule references it) → delete it
  - If the CSS var is **used in a CSS rule** → do NOT just delete it. Replace the var with the nearest equivalent remaining token from the same component (e.g. if `--foo-text-hover` is used in a `:hover` rule, replace it with `--foo-text`). Then delete the declaration. Document the decision as a comment.
  - Never leave a dangling `var(--deleted-name)` reference in a rule.

**Rename pattern** (REMOVED + NEW pair with same value) → A token rename adds a `/default/` or other state segment (e.g. `foo/background/color` → `foo/background/default/color`). Check whether the new name maps to the same CSS var via convention - if dropping `/default` produces the same var name, no CSS var change is needed, only a snapshot and comment update. **Also check if sibling state tokens were added alongside the rename** (e.g. `foo/background/hover/color`) - those are genuine new tokens requiring their own CSS vars and rule wiring.

After any token rename, **re-run the bound walk** before Gate [4] - `bound-tokens.json` still has old names and may diverge from what Figma currently binds in the frames. Also update any matching entries in the `EXPLICIT` map in `parity-check.mjs` and the `EXPLICIT`/`COVERED` sets in `bound-check.mjs` - these two files maintain independent maps that can silently diverge after a rename.

If diff is empty: print `✅ No DS changes since last snapshot (YYYY-MM-DD).`

---


## Phase 1 - Step 4: Impact analysis

For every changed or new token:
- ✅ CSS var exists and already correct - no action
- ⚠️ CSS var exists but value wrong - list it
- ❌ No CSS var - must add one (Hard Rule #1)

**Blocking:** reconcile all changes in CSS before running Phase 2.

---


## Phase 1 - Step 5: Update snapshots

Write fresh live data to both files. **Always stamp `_updated` to today's date on both snapshots**, even when no changes were detected - this is what tells Gate [1] the data is fresh.

> **Also stamp `_figmaVersion` on the vars snapshot.** Fetch it with
> `GET /v1/files/{key}?depth=1` (the `version` field) and write it alongside `_updated`.
> Age answers "when did we capture?"; only the version answers "has the file changed
> since?" - and that is the question that matters. A snapshot taken an hour ago reads
> "✓ updated today" while the designer has since added tokens, and every downstream gate
> then verifies the code against a DS that no longer exists, passing green the whole way.
> Gate [1] compares the two and fails when they diverge. The endpoint works on **every
> plan**, on every plan, so this is a reliable DS-drift signal on any plan. Stamp it only after confirming the capture
> matches the file - stamping a version you did not actually capture asserts a freshness
> that is not there. **Stamp BOTH the vars and the structure snapshot, and read the version
> as the LAST step of Phase 1 (via REST), *after* all Plugin-API page navigations.** A
> `use_figma`/Plugin-API capture calls `figma.setCurrentPageAsync(...)` to reach the
> components page, and that current-page change persists - it bumps the file `version`. So a
> version read *before* the capture's last navigation is already stale by the time you write
> it, and the gate then fails on a bump the capture itself caused, not a designer edit.
> Read the version once at the end and stamp it into both snapshots; do not run further
> page-navigating reads afterward. (If the gate reports a version bump but a full re-walk
> shows identical tokens AND structure, it was almost certainly a read-navigation bump -
> re-stamp; it is not a content change.) Only overwrite the `typography` section if the text-style capture returned real values (empty capture = keep existing). Always write the `aliases` section from the Phase 1 query - it is used by `parity-check.mjs` to verify CSS var chains route through the correct primitive.

**Projects with upstream source cross-check (`figmaSourceKey` set):** After querying the primary file (`figmaFileKey`), also query the upstream DS source file (`figmaSourceKey`) using the same variable script. Write the source results to `figma-vars.snapshot.json` under a `"source"` key alongside the normal `"color"` key. The source data does not replace the primary data - both are written:
```json
{
  "_updated": "YYYY-MM-DD",
  "color":  { "light": { ... }, "dark": { ... } },
  "source": { "light": { ... }, "dark": { ... } },
  "aliases": { ... }
}
```
`parity-check.mjs` reads `snap.source` automatically and routes mismatches where CSS matches the upstream source (but not the primary snapshot) to `⏳ PENDING FIGMA SYNC` instead of `❌ FAIL`. Gate [2] only fails on genuine divergences.

> **⚠️ 32k output token limit:** Claude's response (including all tool call parameters) must stay under 32,000 output tokens. A snapshot for a large collection (>300 tokens) cannot be written in a single `Write` call - the JSON content alone exceeds the limit. **Always use the chunked write protocol below for large snapshots.**

### Chunked snapshot write protocol

**Step A - Write the skeleton** (tiny, always safe):

```json
{
  "_updated": "YYYY-MM-DD",
  "_note": "Machine-generated by /rms-design-system-engine. Do not edit manually.",
  "color": {
    "light": { "__L__": 0 },
    "dark":  { "__D__": 0 }
  },
  "aliases": { "light": { "__AL__": 0 }, "dark": { "__AD__": 0 } },
  "sizing": {},
  "typography": {}
}
```

`__L__`, `__D__`, `__AL__`, `__AD__` are placeholder entries that act as write cursors.

**Step B - Fill each section per batch** using Edit. For each batch of ~190 tokens, replace the placeholder:

- old: `"__L__": 0`
- new: `"token/name/a": "#hex", ...(~190 entries)..., "token/name/z": "#hex", "__L__": 0`

Repeat for every batch. The placeholder migrates to the end of each inserted block.

**Step C - Remove the placeholder** after the last batch:

- old: `, "__L__": 0` (with leading comma)
- new: `` (empty - delete it entirely)

Apply the same B→C pattern for `__D__` (dark), `__AL__` (alias light), `__AD__` (alias dark).

**Step D - Fill sizing and typography** in a single Edit each (these sections are always small).

**Why this works:** each Edit contains ~190 tokens × ~70 chars ≈ 13 kb ≈ 3,200 output tokens - well under the 32k limit. The file stays valid JSON at every step.

**ALIAS FAIL = fix the CSS, never add exceptions.** When `parity-check.mjs` reports `🔗 ALIAS FAIL`, the CSS must be updated to route through the same primitive as Figma. Semantic intermediate vars (`--border`, `--bg`, `--text-muted`) are not allowed as a shortcut when Figma aliases directly to a primitive. There is no exemption map - every alias chain must match exactly.

---


## Phase 1 - Step 6: Verify resolvers

```bash
node ~/.claude/skills/rms-design-system-engine/parity-check.mjs
node ~/.claude/skills/rms-design-system-engine/structure-check.mjs
```

If either reports FAIL, reconcile CSS before Phase 2.

**NEW SKIP = missing CSS var.** A NEW SKIP in Gate [2] means a token is in the snapshot but has no CSS var and no explicit exemption. Treat it exactly like a NEW token from Phase 1 - implement the CSS var before proceeding. Do not accept a passing Gate [2] that has non-zero NEW SKIPs for non-exempt tokens.

**ALIAS FAIL = wrong primitive chain.** A `🔗 ALIAS FAIL` means hex matches but the CSS var routes through a different primitive than Figma. Either fix the CSS chain or add an entry to `KNOWN_INDIRECT_ALIAS` in `parity-check.mjs` if the semantic intermediate is intentional. Treat non-zero ALIAS FAILs the same as FAIL - do not close the audit.

---


## Phase 1 - Step 7: Summary

Print tokens changed/added/removed per section, which CSS vars need updating, confirmation both snapshots refreshed and resolvers pass.
