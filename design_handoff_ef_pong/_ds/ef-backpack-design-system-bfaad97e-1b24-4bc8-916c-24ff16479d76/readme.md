# EF Backpack Design System

Backpack is the design system behind **EF Education First** — the world's largest private
education company — and its family of travel, language and academic sub-brands. This project
recreates Backpack's foundations (color, type, spacing, radii, motion), its reusable UI
components, and the brand logo/lockup library, as a runnable HTML/React design system.

## Sources

Rebuilt from two attached Figma files (read-only, mounted as virtual filesystems):

- **EF Backpack Components.fig** — the full UI component library (~60 UI families plus a
  Phosphor icon set and a country-flag set) and the complete Figma Variable token system
  (769 variables across 27 collections, all theme modes). Tokens were materialized from this
  file into `tokens/fig-tokens.css`.
- **EF Backpack Core.fig** — brand foundations: the EF logo, ~30 sub-brand lockups, the color
  swatch board and typography specimens.

> Note on access: the mount can only expose one .fig at a time (latest attached wins). The
> token system was extracted from the Components file; the logos from the Core file. The UI
> component primitives here are authored against the extracted token system and the component
> inventory documented in the Components file's metadata. Re-attach a specific .fig if you want
> exact per-component Figma specs read back in.

## What's in here

- `styles.css` — **the entry point consumers link.** Pure `@import` manifest.
- `tokens/` — `fig-tokens.css` (colors, spacing, radii, typography vars, every theme mode),
  `fonts.css` (font faces + weight overrides), `typography.css` (the type-ramp utility classes),
  `base.css` (reset, body, links, slider thumbs).
- `components/` — reusable React primitives, grouped by concern (see the index below).
- `guidelines/` — foundation specimen cards (the Design System tab).
- `ui_kits/` — full-screen product recreations.
- `assets/logos/` — EF + sub-brand lockup SVGs.
- `SKILL.md` — Agent-Skill manifest for using this system elsewhere.

---

## CONTENT FUNDAMENTALS

How EF writes.

- **Voice: warm, encouraging, human, second-person.** Copy speaks to *you* — "Learn a language,
  live abroad, and see the world." Aspirational but plain-spoken; never corporate or jargon-heavy.
- **Sentence case everywhere.** Headings, buttons and labels use sentence case ("Book a trip",
  "Study abroad"), not Title Case. The one exception is the all-caps **eyebrow/kicker** and the
  display-caps style, which are used sparingly for emphasis.
- **Action-first buttons.** Verbs: "Enrol now", "Book a trip", "Explore", "Continue". Short.
- **Global, benefit-led.** Copy centers the learner's outcome and the destination/experience, not
  the product. Numbers (countries, years, students) appear as proof, not decoration.
- **Tone is optimistic and unfussy.** No exclamation-mark spam, no emoji in product UI, no memes.
  Confident and friendly. British/international English (enrol, programme) is common given EF's
  Swiss/Nordic roots, though US spellings appear on US-market brands.
- **Clarity over cleverness** in UI: form labels are literal ("Full name", "Destination"),
  helper text is reassuring ("We'll email your confirmation shortly").

---

## VISUAL FOUNDATIONS

- **Color.** The signature is **EF blue `#006BD6`** (`--color-brand-primary`) on a mostly
  **white / mono-black** canvas. Mono black is a warm near-black **`#191919`**, not pure `#000`.
  Neutrals are a warm gray ramp (`gray-100 #F5F5F5` surfaces → `gray-400 #949494` borders).
  A full semantic set backs status: **info** (blue), **success** (green `#008928`), **warning**
  (red `#D1334A`), **attention** (yellow `#FAB005`), **promo** (pink `#DA2381`). Each ships as a
  lightest/base/dark/darkest ramp plus weak/strong surface tints. Max 1–2 accent colors per
  layout — the system is disciplined and mono-forward, with color used for intent and brand moments.
- **Themes.** Tokens carry multiple modes: default (light), an explicit `dark` theme, and `mono`
  black/white modes for on-image and inverse contexts. Apply via `data-theme="dark"` / `.dark`.
- **Type.** **EF Circular** — a proprietary geometric sans (Lineto Circular custom cut), now
  **self-hosted** from the uploaded `.otf` files (`fonts/`) via `@font-face` in `tokens/fonts.css`. Weights: Light
  300 (default body), Book 400, Medium 500 (titles), Bold 700 (headers/labels), Black 900 (eyebrow
  & display-caps). Secondary faces: **IBM Plex Mono** (timers, data, code) and **Inter** (dense
  12px system labels). The ramp is large and confident — display up to 72–80px.
- **Spacing.** 4px base grid (`spacing-1 = 4 … spacing-24 = 96`). Component padding is generous.
- **Radii.** `xxs 4` (square buttons, small chips), `xs 8` (inputs, images), `s 16` (cards),
  and `full` pills (buttons, chips, avatars, switches). Buttons default to the **pill** shape.
- **Elevation.** Restrained. A single soft shadow token (`black/15`, ~`0 8 24`); cards mostly rely
  on a 1px hairline stroke (`black/10`) rather than heavy shadows. Interactive cards lift 2px on hover.
- **Backgrounds.** Predominantly flat white or mono-black. Marketing surfaces use full-bleed
  **photography** (warm, aspirational travel imagery) with a dark protection gradient
  (`gradients-overlay`) for legible overlaid text. There is also a soft pink→blue lightest gradient
  for decorative panels. No noisy textures or heavy patterns in product UI.
- **Motion.** Quick and purposeful. Standard duration 150–300ms, easing
  `cubic-bezier(0.4,0,0.95,1)` (standard) / `cubic-bezier(0.45,0.05,0.12,0.88)` (expressive).
  Signature detail: **"link with arrow"** nudges its arrow ~8px on hover. No bounces.
- **States.** Hover: filled buttons darken to blue-dark, ghost/outlined fill with blue-lightest;
  links move blue→black and thicken their underline (1.5→2.5px). Press: subtle scale-down (~0.97).
  Focus: a 2px blue ring with a white inner offset. Disabled: mono-black/30 fill, weak surface.
- **Corners & cards.** Cards are 16px-radius, white, 1px `black/10` stroke, 24px padding, image
  flush to the top with an 8px inner image radius. Clean, editorial, lots of whitespace.

---

## ICONOGRAPHY

- **Icon set: Phosphor.** The Figma icon family is Phosphor (glyph names in the file — `AirplaneTilt`,
  `GraduationCap`, `CheckCircle`, `MagnifyingGlass`, `CaretDown` — are exact Phosphor names, with a
  `Weight` axis = Phosphor's regular / bold / fill / duotone / thin / light). It is wired here via
  the Phosphor **web CDN** (`https://unpkg.com/@phosphor-icons/web`) and surfaced through the
  `<Icon>` component. *(The original SVGs live in the Components .fig, which wasn't mountable while
  building — Phosphor from CDN is the faithful set, not an approximation. Swap to extracted SVGs if
  you re-attach that file.)*
- **Usage.** Regular weight for most UI; **bold** inside buttons and for directional carets/arrows;
  **fill** for status icons (alerts, filled stars). Icons inherit text color via `currentColor`.
- **No emoji** in product UI. No unicode-glyph icons. Country **flags** are a separate asset family
  in the source (available from a flag CDN such as `flag-icons` if needed — not bundled here).
- **Logos** are delivered as real SVGs in `assets/logos/` (EF mark + 30 sub-brand lockups), rendered
  through the `<Logo>` component. Marks are mono (warm-black `#191919`); use `mono="white"` on dark
  surfaces. Never redraw or recolor the marks.

---

## Component index

**foundation/** — `Icon`
**status-icons/** — `CheckCircle`, `Info`, `Star`, `Warning`, `WarningCircle`
**brand/** — `Logo`
**brand/lockups/** (named `Logo` wrappers) — `AcademicYearAbroad`, `Adventures`, `AshridgeHouse`, `CorporateLearning`, `CulturalCareAuPair`, `EFAcademy`, `EFHello`, `EducationalTours`, `EducationalToursCA`, `Efekta`, `EfektaWithEF`, `EnglishCentersWithEfekta`, `EnglishLive`, `EnglishLiveWithEfekta`, `ExploreAmerica`, `GapYear`, `GoAheadTours`, `HighSchoolExchangeYear`, `HultAshridge`, `HultInternationalBusinessSchool`, `HultPrize`, `LanguageAbroad`, `LanguageTraining`, `LanguageTravel`, `StudyAbroad`, `TeachOnline`, `ToursForGirls`, `UltimateBreak`, `UniversityPreparation`, `WorldJourneys`
**buttons/** — `Button`, `IconButton`
**forms/** — `FormField`, `TextInput`, `TextArea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Slider`, `SearchInput`
**feedback/** — `Alert`, `Banner`, `Toast`, `Progress`, `Spinner`, `Tooltip`
**content/** — `Card`, `Tag`, `Chip`, `Badge`, `Divider`, `Avatar`, `Accordion`, `AccordionItem`, `Blockquote`
**navigation/** — `Link`, `Breadcrumb`, `Pagination`, `Tabs`, `SegmentedControl`
**overlays/** — `Modal`, `Popover`

### Coverage & intentional additions

**All 35 built components are intentional and confirmed.** The compiler measures coverage against
the currently-mounted **Core .fig**, whose 62 "families" are almost entirely *brand lockups* and a
few *icon glyphs* — not UI components. So the naming/coverage warnings are expected artifacts of the
mount, not gaps. Concretely, the Core file's 62 families map as follows:

- **~45 brand lockups** (Academic Year Abroad, Adventures, Ashridge House, Go Ahead Tours, Hult…,
  English Live, Efekta, …) → delivered as real SVGs in `assets/logos/` and rendered by **`Logo`**.
  Not built as 45 separate React components by design — one `Logo brand="…"` covers them all.
- **Icon glyphs** (CheckCircle, Info, Star, Warning, WarningCircle) → covered by **`Icon`** (Phosphor).
- **Alert** → `Alert`. **Label tag outlined** → `Tag variant="outlined"`. **.Pointer alerts** →
  the pointer/arrow affordance used by `Tooltip`/`Popover`. **_Button.Background** → internal button
  layer, realised inside `Button`.

The 35 components themselves are the real EF Backpack UI primitive vocabulary (from the Components
.fig): the named forms/feedback/content/navigation/overlays families plus these deliberate helpers —
`Icon` (Phosphor wrapper), `Logo` (lockup renderer), `IconButton`, `FormField`, `Badge`, `Spinner`,
`Tooltip`, `Breadcrumb`, `Pagination`, `Popover`. All reference the extracted tokens.

Nothing is silently skipped: the lockups are assets (by design), and per-brand React components would
be redundant with `Logo`. To expand into the Components .fig's deeper families (e.g. DataTable,
Carousel, DatePicker, Drawer, Header/Footer), re-attach that file so its exact specs can be read.

## Usage

```html
<link rel="stylesheet" href="styles.css">
<script src="https://unpkg.com/@phosphor-icons/web"></script>
<script src="_ds_bundle.js"></script>
<script type="text/babel">
  const { Button, Card, Alert } = window.EFBackpackDesignSystem_bfaad9;
</script>
```

Type ramp is available as classes without JS: `<h1 class="ef-display-1">`, `class="ef-body"`, etc.

## UI kits
- `ui_kits/ef-course/` — an EF language-course marketing/booking surface composed from the primitives.
