# Singularity UI Governance

This document defines ownership and change rules that keep Singularity visually and behaviorally coherent across AI-assisted development. It does **not** prescribe a new visual style and does not copy DeepSeek Harness Plus presentation.

## Sources of truth

### Enterprise React UI

- `enterprise/apps/web/src/styles.css` owns the current semantic theme values, light/dark pairing, radii, typography bridge, and SiYuan-compatible `--b3-*` aliases used by the enterprise surface.
- `enterprise/apps/web/src/components/ui/` owns reusable React interaction primitives.
- Feature directories such as `spaces/`, `enterprise/`, `shares/`, `auth/`, and `collaboration/` consume those owners. They do not create a second global theme or component system.

### SiYuan-native UI

- `app/**` remains SiYuan-native UI and consumes the existing `--b3-*` semantic styling and neighboring SiYuan components.
- Singularity changes under `app/**` should be as narrow as practical because this surface is upstream-derived and must remain promotable against new SiYuan baselines.

## Rules for AI-generated UI

1. **Inspect before inventing.** Find the nearest working component that solves the same interaction problem before writing new JSX, DOM, Sass, or Tailwind classes.
2. **Semantic values, not copied values.** Reuse theme variables and component variants. Do not copy a hex value, box shadow, radius, transition, or spacing string from another file when a semantic owner exists.
3. **Primitive before page-local control.** Use the existing button, input, dialog, menu, table, tab, tooltip, badge, toast, or other primitive when available.
4. **No parallel design system.** Adding another UI framework, icon system, global theme file, or independent token scale requires an architecture decision, not a feature-local preference.
5. **One owner per state.** UI state is derived from product/application state. Do not introduce mirrored selected/open/permission values only to make styling easier.
6. **Paired themes.** Light and dark use the same component geometry and interaction. Theme branches change semantic values, not layout structure.
7. **Complete visible states.** A feature owns the loading, empty, failure/recovery, permission, disabled, success, destructive-confirmation, keyboard, and focus states that are part of its accepted user path.
8. **Responsive and overflow behavior is designed, not accidental.** Long labels, tables, errors, lists, sidebars, dialogs, and embedded editor surfaces must have an explicit wrap/scroll/truncation rule.
9. **Copy is product UI, not developer documentation.** Do not expose package names, ports, database topology, Git terminology, or framework explanations in normal user flows.
10. **Screenshots are secondary evidence.** Functional browser automation demonstrates the path. Screenshots may demonstrate hierarchy and final appearance after async work and animation settle.

## When adding a token

Add a shared semantic token only when at least one of these is true:

- multiple components need the same semantic role;
- a light/dark pair must remain centrally coordinated;
- the value expresses a stable product role such as foreground, border, destructive state, focus, surface, or elevation.

A one-off geometry value that belongs only to one component may remain local. A shared color/elevation/typography/motion role belongs to the theme owner.

## When adding a primitive

Create a new reusable primitive only when existing primitives cannot represent a repeated interaction without duplicating accessibility, keyboard, focus, or state behavior. A primitive must define:

- owner and public variants;
- semantic tokens it consumes;
- keyboard/focus behavior;
- disabled/loading/error behavior where applicable;
- expected composition boundaries;
- a representative test or real feature usage.

## Review evidence

A non-trivial visible PR should state:

- which existing page/pattern was used as the reference;
- which primitives were reused or added;
- which semantic tokens were reused or changed;
- whether upstream-native `app/**` styling changed;
- browser viewport(s) and light/dark states verified;
- real user path exercised in Playwright;
- residual native-platform or visual acceptance work, if any.

The goal is not pixel sameness. The goal is consistent ownership, hierarchy, interaction, accessibility, and evidence so independent AI changes still feel like one product.
