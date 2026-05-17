---
version: alpha
name: ClipIQ
description: A quiet, editorial design system for a desktop video-analysis tool. Slate ink on near-white paper, indigo reserved for the single most important action per surface, monospace strictly for metadata. Hierarchy is built from 1px borders and tonal layers, not shadow stacks.

colors:
  primary: "#0a0a0b"
  secondary: "#5b606e"
  tertiary: "#4f46e5"
  neutral: "#fbfbfc"
  surface: "#fbfbfc"
  surface-muted: "#f4f5f7"
  on-surface: "#0a0a0b"
  error: "#b91c1c"

  ink-11: "#14151a"
  ink-10: "#1f2128"
  ink-9: "#2c2f38"
  ink-6: "#6f7484"
  ink-2: "#ebedf1"
  ink-1: "#f4f5f7"

  accent-ink: "#3730a3"
  accent-soft: "#eef0ff"
  accent-line: "#c7cbf5"

  ok: "#0c6e3d"
  ok-soft: "#e6f4ec"
  warn: "#b45309"
  warn-soft: "#fdf3e7"
  danger: "#b91c1c"
  danger-soft: "#fbeaea"

typography:
  headline-lg:
    fontFamily: -apple-system, BlinkMacSystemFont, SF Pro Display, system-ui, sans-serif
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.015em
  headline-md:
    fontFamily: -apple-system, BlinkMacSystemFont, SF Pro Display, system-ui, sans-serif
    fontSize: 17px
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: -apple-system, BlinkMacSystemFont, SF Pro Text, system-ui, sans-serif
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.4
  body-lg:
    fontFamily: -apple-system, BlinkMacSystemFont, SF Pro Text, system-ui, sans-serif
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: -0.003em
  body-md:
    fontFamily: -apple-system, BlinkMacSystemFont, SF Pro Text, system-ui, sans-serif
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: -apple-system, BlinkMacSystemFont, SF Pro Text, system-ui, sans-serif
    fontSize: 12.5px
    fontWeight: 400
    lineHeight: 1.55
  label-md:
    fontFamily: ui-monospace, SF Mono, JetBrains Mono, Menlo, monospace
    fontSize: 11.5px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0.05em
  label-sm:
    fontFamily: ui-monospace, SF Mono, JetBrains Mono, Menlo, monospace
    fontSize: 10.5px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0.07em
  data-md:
    fontFamily: ui-monospace, SF Mono, JetBrains Mono, Menlo, monospace
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
  data-display:
    fontFamily: ui-monospace, SF Mono, JetBrains Mono, Menlo, monospace
    fontSize: 22px
    fontWeight: 500
    lineHeight: 1
    letterSpacing: -0.01em

spacing:
  xs: 4px
  sm: 8px
  md: 12px
  base: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
  gutter: 20px

rounded:
  none: 0
  sm: 4px
  md: 6px
  lg: 8px
  xl: 12px
  2xl: 18px
  pill: 999px
  full: 9999px

components:
  button-primary:
    backgroundColor: "{colors.tertiary}"
    textColor: "#ffffff"
    rounded: "{rounded.lg}"
    padding: 14px
    height: 32px
    typography: "{typography.body-md}"
  button-primary-hover:
    backgroundColor: "{colors.accent-ink}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.lg}"
    padding: 14px
    height: 32px
    typography: "{typography.body-md}"
  button-secondary-hover:
    backgroundColor: "{colors.ink-1}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-9}"
    rounded: "{rounded.lg}"
    padding: 14px
    height: 32px
    typography: "{typography.body-md}"
  button-ghost-hover:
    backgroundColor: "{colors.ink-2}"
    textColor: "{colors.ink-11}"
  send-button:
    backgroundColor: "{colors.tertiary}"
    textColor: "#ffffff"
    rounded: "{rounded.full}"
    size: 38px
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-9}"
    rounded: "{rounded.pill}"
    padding: 12px
    height: 30px
    typography: "{typography.body-sm}"
  chip-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-ink}"
  badge:
    backgroundColor: "{colors.ink-2}"
    textColor: "{colors.ink-9}"
    rounded: "{rounded.sm}"
    padding: 7px
    height: 20px
    typography: "{typography.label-sm}"
  badge-accent:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-ink}"
  badge-ok:
    backgroundColor: "{colors.ok-soft}"
    textColor: "{colors.ok}"
  badge-warn:
    backgroundColor: "{colors.warn-soft}"
    textColor: "{colors.warn}"
  badge-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: 16px
  card-muted:
    backgroundColor: "{colors.surface-muted}"
    rounded: "{rounded.xl}"
    padding: 16px
  input-field:
    backgroundColor: "transparent"
    textColor: "{colors.primary}"
    rounded: "{rounded.lg}"
    padding: 6px
    height: 52px
    typography: "{typography.body-lg}"
  composer:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.2xl}"
    padding: 4px
  composer-focus:
    backgroundColor: "{colors.surface}"
  composer-url:
    backgroundColor: "{colors.surface}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-10}"
    rounded: "{rounded.lg}"
    padding: 9px
    typography: "{typography.body-md}"
  nav-item-active:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.error}"
    rounded: "{rounded.lg}"
    padding: 14px
    height: 32px
    typography: "{typography.body-md}"
  button-danger-hover:
    backgroundColor: "{colors.danger-soft}"
  caption:
    backgroundColor: "transparent"
    textColor: "{colors.secondary}"
    typography: "{typography.body-sm}"
  body-text:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
  input-placeholder:
    backgroundColor: "transparent"
    textColor: "{colors.ink-6}"
    typography: "{typography.body-md}"
---

# ClipIQ Design System

## Overview

ClipIQ is a desktop video-analysis tool for content reviewers and editors. People sit with it for long sessions: scrubbing footage, reading per-shot breakdowns, switching between dense reports and a video player. The interface therefore prioritizes legibility and quiet over decoration. The product should feel like a well-built reading tool, not a SaaS dashboard.

The aesthetic family is editorial / minimalist, in the lineage of Stripe Press, Apple Human Interface Guidelines, and modern documentation sites. Concretely this means:

- **Slate ink on near-white paper** — never pure black on pure white, never colored backgrounds for ambient sections.
- **Indigo as the single accent** — used only where one decision matters most: a primary CTA, the currently active item, a value worth flagging. Never decorative.
- **Monospace for metadata** — timestamps, model identifiers, ports, file names, scores, durations. The mix of serif-like sans body and mono metadata is the product's signature.
- **Hierarchy through 1px borders and tonal layers**, not shadow stacks. Cards sit on the same plane as the page; what separates them is a hairline rule and a slightly cooler background tint when emphasis is needed.

The product must never read as &ldquo;AI-generated SaaS&rdquo;: no purple-pink gradients, no left-border accent cards, no emoji used as icons, no display fonts borrowed from launch-page clichés (Inter, Roboto, Fraunces). The accent palette is intentionally narrow so deviations stand out.

## Colors

The palette is rooted in a long neutral ink scale and a single interaction accent. Three intent palettes (ok / warn / danger) are reserved for status surfaces and never used as decoration.

- **Primary ink (#0a0a0b)** &mdash; deep slate used for headlines and core text. Pure black is avoided; near-black reads warmer and reduces eye strain over long sessions.
- **Secondary slate (#5b606e)** &mdash; used for metadata text, captions, and 1px borders that separate sibling surfaces. This is the dominant non-primary text color.
- **Tertiary indigo (#4f46e5)** &mdash; the sole driver of interaction. Used for the primary CTA on a screen, the active state of a navigation item, the highlighted node currently being inspected, and key-value emphasis (&ldquo;currently using X&rdquo;). Never used for backgrounds of decorative or ambient elements.
- **Neutral paper (#fbfbfc)** &mdash; the background of every surface, including cards. Cards do not have a different fill color; they are separated from the page by a 1px ink-2 border. This is what gives the product its &ldquo;flat editorial&rdquo; feel.

The ink scale (`ink-1` through `ink-12`) is a perceptually-spaced ramp used for borders, dividers, disabled states, secondary text, and muted backgrounds. Designers do not introduce new neutrals; they pick a step on this ramp.

The accent palette is a 4-token family: `accent` (the indigo itself), `accent-ink` (a darker hover / pressed state), `accent-soft` (a near-white indigo tint used as the fill of subtle active states and chips), and `accent-line` (the border color of accented containers, e.g., a focused input).

Status palettes (`ok`, `warn`, `danger`) each ship with a `-soft` variant. The bare token is used for text and small dots; the soft variant fills a status badge or callout. A red border on a destructive button is acceptable; a red background on a destructive button is not &mdash; the product avoids alarming surface area.

## Typography

ClipIQ uses two font families, both system-resident, so the product needs no web font loading:

- **System sans (Apple SF Pro on macOS, system fallback elsewhere)** for all narrative text: headlines, body, navigation labels, button text.
- **System monospace (SF Mono on macOS, fallback chain)** for metadata only: timestamps, durations, model IDs, port numbers, file names, scores, hex codes, and any tabular numeric display.

The mix is strict and intentional. If a value is &ldquo;the kind of thing you would copy and paste,&rdquo; it goes in monospace. If a value is prose, it goes in sans. This rule is what makes a ClipIQ surface feel different from a generic dashboard: the eye learns within seconds where to look for facts versus where to read.

There are nine type roles. Headlines top out at 22px (`headline-lg`); the product does not use display-scale type because there is no marketing surface inside the app. Body sits at 14&ndash;16px; metadata labels at 10.5&ndash;12px with positive letter spacing and uppercase. A single `data-display` role at 22px monospace is reserved for hero numbers (a score, an ETA, a running total).

Designers do not introduce new typography levels for one-off layouts. If a label feels too small, the answer is to use one of the existing label roles at the right weight, not to invent a 13px in-between.

## Layout

The base unit is 8px. A 4px half-step is permitted for micro-alignment inside a single component (e.g., the gap between a chip's dot and its label). All padding, gap, and margin values must resolve to a multiple of 4px.

The application uses three layout containers:

- **A 220px left navigation rail**, sticky to the viewport. The rail is the only persistent navigation; there are no top tabs.
- **A scrolling main surface** with 40px horizontal padding and 28px top padding. Section gaps inside the surface are 28px (between major regions) or 14&ndash;18px (between sibling cards in the same region).
- **A fixed-position Tweaks / settings overlay** in the bottom-right when active, with `2xl` rounded corners and a single hairline border. This is the only floating element.

Cards inside a region align to the same grid; they do not nest more than two levels deep. If a layout needs three levels of nesting, the inner level is broken into its own region.

The 1200px max width is not enforced &mdash; on a desktop video tool the user benefits from wider video previews and node lists, and the workspace screen explicitly uses a two-column split that consumes the full viewport.

## Elevation & Depth

ClipIQ is a flat design with **zero ambient shadows**. Visual hierarchy is conveyed exclusively through:

1. **Hairline borders** (1px, `ink-2` for default, `ink-3` for emphasis, `accent-line` for active). Borders are the primary affordance for &ldquo;this is a container.&rdquo;
2. **Tonal layers** &mdash; `surface-muted` (`ink-1`) is used as the background of muted information regions: a summary card on the workspace, an &ldquo;already completed&rdquo; stage in progress, the navigation rail. The shift from `surface` to `surface-muted` is intentionally subtle.
3. **Focus rings** &mdash; the only non-border depth cue. A focused composer or selected node gets a 3px `accent-soft` outline immediately outside its 1px border. This is the closest the design comes to a shadow.

Drop shadows are reserved for two surfaces only: the Tweaks floating panel (`0 1px 2px rgba(15,16,20,.04), 0 8px 24px rgba(15,16,20,.08)`) and any modal / dialog that overlays the canvas. Cards, buttons, inputs, and chips never receive a shadow.

The dark mode counterpart inverts the ink scale and shifts the background to a near-black paper (`#0c0d10`), but the same rules apply: still flat, still bordered, still no shadows on regular components.

## Shapes

The shape language is **measured, not soft**. Border radius scales from 0 (none) through 18px (`2xl`, used only for the composer container), with three workhorse stops:

- **`sm` (4px)** &mdash; badges, small status pills, internal chip dots.
- **`md` (6px)** &mdash; small buttons inside compact toolbars, segmented controls.
- **`lg` (8px)** &mdash; standard buttons, inputs, nav items. This is the most common radius and the default when none is specified.
- **`xl` (12px)** &mdash; cards, containers, side panels.
- **`2xl` (18px)** &mdash; the home composer and the floating Tweaks panel only. Not used for general cards.
- **`pill` / `full`** &mdash; reserved for chips (pill) and the circular send button (full).

Mixing radii within a single screen is acceptable as long as nested elements use a smaller radius than their parent (a chip with `pill` radius inside a card with `xl` radius is correct; the inverse is not). The product never uses sharp 0 corners except for full-bleed surfaces like a video preview frame.

## Components

Below is the canonical inventory. Variants are expressed as separate component entries using related keys (e.g., `button-primary` and `button-primary-hover`). The tokens define the styling; the prose below defines the application rules.

### Buttons

- **`button-primary`** &mdash; one per screen, sometimes one per dialog. Marks the action that completes the screen's intent (Start analysis, Confirm, Save, Open). Indigo fill, white text.
- **`button-secondary`** &mdash; standard action button with paper background and a 1px ink-3 border. Used for any action that isn't the screen's primary intent.
- **`button-ghost`** &mdash; borderless, transparent fill. Used for low-priority actions: Cancel in a confirmation, Reset, individual row-level operations like Open / Retry / Delete in a project list.
- **`send-button`** &mdash; a 38px circular variant reserved for the composer's submit affordance. Indigo fill, white up-arrow icon. The shape itself communicates &ldquo;commit this input.&rdquo;

Destructive actions (Delete, Discard) use `button-ghost` with `danger` text color, not a red-filled button. A red fill would over-weight the action.

### Chips

A chip is a small selectable / informational element used in toolbars and the home composer. Pill-shaped, 30px tall, sans body-sm typography.

- **`chip`** &mdash; default state, paper background with a 1px ink-2 border.
- **`chip-active`** &mdash; selected state, accent-soft fill with accent-ink text. A 6px accent dot may appear inside.

Chips are interactive: clicking a chip opens a small menu or toggles state. A chip is never used as a static label &mdash; if a value isn't clickable, it's a badge or plain text instead.

### Badges

Badges are non-interactive status markers, rectangle with `sm` radius, monospace label typography, uppercase. The default badge uses `ink-2` fill; status variants use the four soft palettes (`accent`, `ok`, `warn`, `danger`).

Badges are positioned inline with text (e.g., next to a section heading), never floating. A badge never carries an interactive affordance &mdash; if a user can click it, it's a chip.

### Cards

Cards are the standard container for grouped content. Paper background, 1px ink-2 border, `xl` radius. A muted variant (`card-muted`) uses `surface-muted` fill for ambient information that should sit visually below regular cards (e.g., the global-summary card on the workspace).

Cards never receive shadows. Cards never stack more than two levels deep. Cards do not have headers with a different background fill &mdash; if a card needs a header, it's separated from the body by a 1px ink-2 rule.

### Input field

A 52px tall text input with 16px body typography. Inputs do not draw their own border; they rely on the parent container (a composer, a settings row) to provide the visual frame. This keeps the input field itself quiet and makes the parent container the affordance.

### Composer

The home-screen input region. A large `2xl` rounded container holding (top) an attach button + text input, (bottom) a chip toolbar + circular send button. The composer changes its border color from `ink-3` (default) to `accent-line` (when the input contains a recognized URL) to `accent` (when focused). This three-state border treatment is the only border-color animation in the system.

### Navigation item

A row in the left rail. 9px padding, `lg` radius, body-md typography. Default state: transparent fill, ink-10 text. Active state: `primary` fill (deep ink), `neutral` text (paper). The active state inverts the relationship deliberately &mdash; this is the strongest contrast in the product and the user always knows where they are.

## Do's and Don'ts

- Do reserve the indigo accent for one primary action per screen, one active item per navigation, and one highlighted entity per list. If two things on a screen feel equally important, one of them isn't.
- Do put every timestamp, model name, port, score, file name, and hex code in monospace. The product earns its character from this discipline.
- Do separate sibling surfaces with a 1px ink-2 border, not a shadow.
- Do use the soft status palettes (`-soft`) for fills and the bare status colors for text and small marks. A red-filled destructive button is over-weight.
- Do scale type within the nine defined roles. If you reach for a 13px in-between, you're solving a layout problem with the wrong tool.

- Don't introduce purple-to-pink gradients, sweeping color washes, or any decorative gradient. The aesthetic is deliberately quiet.
- Don't use emoji as iconography. Icons are inline SVG with `currentColor` stroke. If no icon exists, use a square placeholder labeled `[icon]` until a real one is sourced.
- Don't mix radii inverted (a small-radius child inside a smaller-radius parent). Children may match or be smaller, never larger.
- Don't add ambient shadows to cards, inputs, buttons, or chips. Only floating overlays receive shadows.
- Don't introduce a new neutral hex value when an `ink-N` token already exists at the same step. Designers extend the system from the palette, not from intuition.
- Don't write UI copy that explains the design's intent (&ldquo;Same input box auto-detects, you don't need to choose first&rdquo;). UI copy describes what something is or does, not why it was designed that way.
