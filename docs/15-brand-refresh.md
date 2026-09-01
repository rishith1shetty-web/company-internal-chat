# 15 — Brand refresh: Rising Path Recruiters

A **UI-only** pass over the existing interface. No route, API, schema, query, socket event,
identity rule or file-transfer behaviour was changed. Phases 1–7 behave exactly as before; this
document records what the interface now looks like and why.

---

## 1. What this pass did and did not touch

| Changed | Not changed |
| --- | --- |
| Design tokens in `app/globals.css` | Every API route and its contract |
| Component styling and layout chrome | The Prisma schema and all migrations |
| Copy where it named the product | Identity, sessions, devices, enrollment |
| The brand assets and the favicon | Conversation, group and membership logic |
| Avatar tint palette | File upload, storage, authorization, download |

`npm test` stayed at **268 passing** across the pass, and the three browser regressions
(admin/setup 60, groups 47, files 25) still pass in full.

---

## 2. The palette is derived from the logo, not chosen to match it

Three colours were sampled from the supplied artwork by decoding the PNG and counting its
non-white pixels:

| Sampled | Where it is in the logo |
| --- | --- |
| `#A8682B` | the "RISING PATH" wordmark |
| `#F0A018` | the deeper end of the sun and arrow gradient |
| `#F8C810` | the brighter end of it |

**Those are brand colours, not usable colours.** Measured against white, the bronze is 4.49:1 and
the gold is 2.15:1 — neither may carry body text. Rather than quietly darkening the brand until it
passed and calling that the brand, each hue was given the job it can actually do:

| Token | Value | Role |
| --- | --- | --- |
| `--color-brand` | `#A8682B` | The logo bronze itself. Headings, icons, brand marks. **Never body text.** |
| `--color-accent` | `#8A5220` | Bronze darkened until it is safe both ways (6.35:1 with white). Primary actions, own messages, selected rows. |
| `--color-gold` | `#F0A018` | A **fill**, never a foreground. Dark ink on it is 8.07:1 — unread badges, the header rule, progress. |

Neutrals were warmed to match (`#F6F2EC` canvas, `#23180E` ink) so the interface reads as one
thing rather than a bronze accent dropped onto cool grey.

### Measured contrast

Every pairing the interface uses was computed from WCAG relative luminance, not estimated:

```
ink        #23180E on surface  17.4:1      accent  #8A5220 on surface   6.4:1
ink-muted  #5C4B3A on surface   8.3:1      white   #FFFFFF on accent    6.4:1
ink-subtle #77634D on surface   5.7:1      ink     #23180E on gold      8.1:1
ink-subtle #77634D on canvas    5.1:1      danger  #B3261E on surface   6.5:1
ink-subtle #77634D on muted     5.4:1      online  #12805C on surface   4.9:1
```

The lightest text in the interface is 5.1:1 — the previous palette's floor was 4.8:1, so contrast
went **up**, not down, in exchange for the warmth.

### Avatar tints

The six stock Tailwind hues (blue, emerald, amber, violet, rose, teal) were replaced with one warm
family around the brand: amber, bronze, clay, olive, teal, sand. A group conversation shows six of
these at once, and an unrelated rainbow is the detail that makes an otherwise composed interface
look assembled from parts. Each foreground is between 5.7:1 and 6.4:1 on its own tint.

---

## 3. Where the logo is, and where it deliberately is not

The asset is the company's own file. `public/brand/rising-path-recruiters.png` is what was
supplied, byte for byte. Two crops of it are what the interface actually renders:

| File | What it is |
| --- | --- |
| `rising-path-recruiters.png` | The supplied artwork, untouched (2000×2000) |
| `rising-path-lockup.png` | The same image with its surrounding whitespace removed |
| `rising-path-mark.png` | The sun-and-path symbol alone, squared with transparent padding |
| `app/icon.png`, `app/apple-icon.png` | The mark resampled to 64px and 180px |

Nothing is redrawn, recoloured or approximated, and **no vector imitation of the logo exists in
this codebase**. Both crops are imported statically through `components/brand/Logo.tsx`, so Next
knows their intrinsic size and the browser reserves the box before the bytes arrive.

**Placements**, all of them:

| Surface | Which | Why there |
| --- | --- | --- |
| Application header | mark | One mark, top left, on every screen of the product |
| Empty chat state | full lockup | The largest empty area in the product, and the first thing a new employee sees |
| Unassigned computer | full lockup | No header above it; the logo is the only identification |
| Setup (`/setup`) | full lockup | Runs on a machine nobody is signed in to — it has to say whose system this is |
| Admin sign-in | full lockup | Same reason |
| Admin console header | mark | A place of work somebody returns to; a wordmark every visit is a banner, not an aid |
| Loading screen | full lockup | Fills a wait that would otherwise be a bare line of text |
| Browser tab / home screen | mark | `app/icon.png`, discovered by Next's convention |

**Not** in the sidebar, the conversation list, any dialog, the details panel, the composer, or
inside a message. A logo repeated on every surface stops reading as a brand and starts reading as
wallpaper.

---

## 4. What made it feel premium

None of this is decoration for its own sake; each item is listed with the job it does.

- **Warm-tinted elevation.** Shadows are `rgb(64 43 20 / …)`, not black. A grey shadow over a warm
  surface reads as dirt; a bronze-tinted one reads as depth. Four steps: `subtle`, `card`,
  `raised`, `overlay`.
- **A gold hairline under the header.** 2px of the logo's own gradient in place of another grey
  border — the one flat band of the brand's brightest colour in the interface.
- **A warm wash behind the conversation.** Two radial gradients, both under 6% alpha, in pure CSS.
  No image request, nothing to load, and nothing that competes with the messages.
- **Message bubbles.** Own messages are the company bronze with white on it; everyone else's are
  white with a hairline and a whisper of shadow. The "tail" is the one corner left square on the
  side the message came from.
- **The composer is one control.** Focus lights up the whole row, so the paperclip, the field and
  Send read as one thing rather than three adjacent things.
- **Selected conversation, marked three ways.** A gold rail, a tinted fill and a hairline ring —
  never colour alone, and `aria-current` says the same thing to a screen reader.
- **One press animation.** `active:translate-y-px` on every button. A transform, so it costs no
  layout, and it ends when the pointer lifts.
- **Two durations and one curve**, shared by everything (`--duration-quick` 120ms,
  `--duration-settle` 220ms, `--ease-out-soft`), so no two controls animate differently.
- **Dialogs arrive.** 4% scale and 8px of travel over 220ms, with the backdrop blurred as well as
  darkened — the convention for "what is behind this is not available right now".
- **Tabular numerals** on timestamps, file sizes and counts, so they do not twitch as they change.
- **Warm thin scrollbars**, so a long conversation has no grey stripe down the side of a bronze
  interface.

Everything above respects `prefers-reduced-motion`, which was already honoured globally and still
is.

---

## 5. Typography: why no web font was added

The obvious move for a premium refresh is a Google font pairing. It was not made, for a reason
specific to this product: **the application is hosted on the company's own server and Phase 8
restricts it to the company network.** A stylesheet from `fonts.googleapis.com` would be a request
to the public internet on every cold load — one that fails on exactly the restricted network this
system is built for, and that leaks a request outward from a private system if it succeeds.

Self-hosting through `next/font` would solve the runtime problem but makes the build depend on
network access, and it adds weight to a first paint on a LAN that is currently instant.

So the type is a refined system stack (`Segoe UI Variable Text` first on Windows, where every
company machine here runs), with the hierarchy carried by weight, size, tracking and colour
instead — which cost nothing and were the things actually missing. If a licensed brand typeface is
supplied later, it belongs as self-hosted files in `public/brand/` and one `@font-face` block in
`globals.css`; the token seam is already there.

---

## 6. Adding to this system

Colours, radii, shadows and durations are tokens in the `@theme` block of `app/globals.css`, and
components reference them by name (`bg-surface`, `text-ink-muted`, `shadow-card`,
`rounded-control`). **No component carries a raw hex value.** A new surface should reuse an
existing token; if it genuinely needs a new one, add it there, measure its contrast against the
surfaces it will sit on, and record the ratio in the comment block with the others.

Three utilities exist for the brand itself and should not be reimplemented inline:
`chat-canvas` (the warm wash), `brand-gradient` (the sun gradient, behind marks and progress) and
`brand-rule` (the gold hairline).
