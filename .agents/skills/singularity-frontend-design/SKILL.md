---
name: singularity-frontend-design
description: Use before implementing visible Singularity UI. Preserve a coherent product by consuming the existing semantic tokens, primitives, interaction patterns, and real user-path evidence instead of copying a screenshot or inventing a parallel style system.
---

# Singularity Frontend Design

This skill governs **how AI makes UI changes**, not what visual style the product must imitate. The goal is a consistent, calm, understandable product even when many agents work on different surfaces over time.

## Read first

Before changing visible UI:

1. Read `docs/ui-governance.md`.
2. Read `enterprise/apps/web/src/styles.css`; it is the current semantic theme source for the enterprise React UI.
3. Read `enterprise/apps/web/src/components/ui/`; reuse an existing primitive before creating a new one.
4. Read the nearest working page or feature with the same interaction type and record its layout density, control size, icon language, loading/error treatment, keyboard behavior, and responsive behavior.
5. If changing SiYuan-native UI under `app/**`, read the nearest native SiYuan component and consume `--b3-*` semantic variables rather than transplanting enterprise-only presentation.
6. Read the owning `AGENTS.md` and the accepted product/architecture plan.

Do not begin from a screenshot approximation. Do not add a second component library, theme owner, icon language, spacing scale, or ad-hoc global stylesheet to make one page look right.

## Design contract

- **Semantic tokens own visual decisions.** Feature code consumes semantic variables/classes; shared color, typography, radius, elevation, and motion changes belong to the designated theme owner.
- **Primitives own interaction.** Buttons, menus, dialogs, fields, tooltips, tabs, tables, toasts, and focus behavior reuse `components/ui` or the nearest native SiYuan primitive.
- **One state owner.** A selected value, open state, active item, or permission state has one authoritative owner. Derive labels and visuals from it instead of mirroring state for presentation.
- **Light and dark are one design.** Keep geometry, hierarchy, spacing, and interaction identical across themes; change semantic values, not component structure.
- **Accessibility is part of the component contract.** Preserve keyboard reachability, visible focus, semantic roles/labels, reduced motion, and readable contrast.
- **Hierarchy before decoration.** Every border, shadow, gradient, animation, accent, or card must communicate hierarchy, state, or affordance. Decorative duplication is removed.
- **Stable layout.** Define width, height, wrapping, overflow, empty states, long labels, errors, and dynamic content before polishing.
- **One primary action.** A workflow step should make the next action obvious without developer-facing explanation.
- **User language only.** Package names, ports, database internals, Git, deployment topology, and debugging explanation do not belong in normal product copy.

## Implementation sequence

1. State the user goal and smallest visible path.
2. Locate the nearest existing component/pattern and list what will be reused.
3. Identify the semantic tokens and primitives that own the surface.
4. Define layout/overflow and responsive behavior before styling details.
5. Implement owner state and functional behavior first.
6. Implement required loading, empty, permission-denied, failure, recovery, disabled, hover, focus, keyboard, success, and destructive-confirmation states that belong to the accepted path.
7. Only add a new token or primitive when reuse cannot express a repeated product need; document its ownership and intended reuse.
8. Keep implementation comments about contracts and ownership, not visual trial-and-error history.

## Verification

Use Playwright or the existing browser test path to **operate the real workflow**. Verify at minimum:

- primary user action completes through the visible UI;
- loading, empty, error/recovery, disabled, and permission states relevant to the path work;
- keyboard operation and focus return work for menus/dialogs/selectors;
- dynamic content does not shift the layout into overlap or unintended page/window overflow;
- light and dark themes preserve the same geometry and hierarchy;
- console and failed network requests are inspected;
- changed UI uses existing primitives/tokens rather than literal presentation values where a semantic owner exists.

Screenshots may document the final appearance, but a screenshot is never evidence that the interaction works. Visual regression evidence should be captured only after animations and async loading settle.

## Review questions

- Can a user identify the next action without technical explanation?
- Does this look and behave like a neighboring Singularity/SiYuan surface because it reuses the same owners, not because CSS was copied?
- Did the change introduce a second source of truth for state, theme, icons, or components?
- Are light/dark, keyboard, empty/error, and long-content states intentional?
- Does every decorative effect serve hierarchy or state?
- If a new primitive/token was added, is it reusable and owned, or is it a one-off workaround?

Record UI ownership, reused primitives/tokens, and verification evidence in the pull request under `## Frontend design`.
