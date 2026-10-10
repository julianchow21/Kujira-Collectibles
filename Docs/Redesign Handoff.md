You are picking up a UI redesign of Kujira Collectibles, a Pokémon card collection tracker (single-page PWA, no framework, no build step). Julian approved the design direction in a previous Claude Code session on 6 Oct 2026 and wants you to start implementing it, beginning with Step 1 below.

## 0. Setup and ground rules

- **Repo and branch.** The repo is https://github.com/julianchow21/Kujira-Collectibles. Clone it and work on the `redesign` branch (`git checkout redesign`). That branch is `main` at v3.67 (`893e740`) plus this handoff and the mockups. No app code has changed yet.
- **Never push to or merge into `main` without Julian's explicit yes.** `main` is what GitHub Pages serves as the live app (https://julianchow21.github.io/Kujira-Collectibles/).
- **Commits and pushes.** Commit to `redesign` at the end of each step once Julian has seen the screenshots. Push `redesign` only when he says so.
- **`CLAUDE.md` and `AGENTS.md` are gitignored, so they are not in your clone.** `CLAUDE.md` is the authority on architecture, the ship rule and data safety. Julian will copy it into the repo root by hand; if it's there, read it first. It also has a private security section, so never commit it. Until it arrives, section 4 below has the essentials.
  - It points to a generic gotchas file under `~/.assistant-control`. That file doesn't exist, so ignore the pointer.
  - Its "Browser" section was written for a different harness. Use whatever browser or preview tool you have.
- **`Docs/` is also gitignored.** Only this handoff and `Docs/Redesign Mockups/` were force-added. Keep any new notes in `Docs/` local, or force-add them on purpose.
- **Access you need:** push access to this repo, Node 18 or later (for `npx serve` and `node --test`), and a browser for previews. UI work does not need Supabase, Cloudflare or pricing keys, so don't ask for them.
- **Before any change,** run `./qc.sh` and `node --test` to get a green baseline. Keep both green after every step.
- Local dev: `npx serve -l 3800 .`. The app is auth-gated, and localhost previews never write to production (`isLocalhostPreview()`). To see the app with data, run `node tests/preview-server.cjs` (port 4187: it strips the auth gate, seeds sample singles and blocks network). Or, in the page console on localhost: seed `localStorage['pokeinventory_v3']` with `{singles, slabs, sales, etbs, boosterBoxes, boosterPacks, ebayPurchases}`, stub `window.fetch` to reject, remove `#kjr-auth-gate`, `#intro` and the `auth-gated` class on `<html>`, then call `kjrStartOwnerApp()`.
- Never touch pricing, sync, trash or Supabase logic as part of this work. Never commit, push or deploy without Julian saying so. Show before and after screenshots (desktop at about 1366 px, mobile at 375 px, dark and light themes) at the end of each step.
- Ship rule (see `CLAUDE.md` and `qc.sh`): when a step ships, bump the version in the `#app-ver` badge, every `?v=` asset tag in `index.html` (styles.css plus 7 scripts), the Sentry `release` string and `sw.js` (`CORE` list and cache version), all in the same edit.

## 1. The design

Julian's canvas holds five boards: Overview desktop, Singles grid and list, Card inspector, Mobile home, and Style sheet.

- **Source (use this first):** the mockup source is in the repo at `Docs/Redesign Mockups/` (`Main.dc.html` Overview, `Collection.dc.html` Singles, `Detail.dc.html` Card inspector, `Mobile.dc.html`, `System.dc.html` Style sheet). Read them for exact colours, spacing, radii, sizes and copy.
  - They are written for a design-canvas runtime, so they do not render when opened directly in a browser. Treat them as a reference spec, not code to copy in.
  - Inside them, `{{name}}` placeholders take their values from the data in `renderVals()` at the bottom of each file. `<sc-for>` is a loop and `<sc-if>` is a conditional.
  - The sample numbers are made up, so don't reuse them.
- **Rendered view:** https://claude.ai/artifact/Tbh4RVdc9d1LsDGo4pLDsU. If you have the Artifact tool on Julian's account, you can read it there too. Otherwise ask Julian for screenshots.
- **If neither is available,** the spec below is complete enough to build from.

Direction: a dark gallery. Neutral near-black surfaces, one violet accent, and the card art supplies the colour. Numbers lead, chrome stays quiet. The holographic whale logo is the only multicolour brand element.

What the audit found wrong (the reasons behind the changes):
- No card imagery anywhere, so it reads as a spreadsheet.
- Five equal KPI tiles mean nothing leads. The Custom Chart Builder takes most of the dashboard.
- Noise: an always-on per-column filter row under every table header, 4 action icons on every row (including a red ×), coloured pills on most cells (a green "Raw" pill reads as "good"), an info icon on every tile, and a permanent red "Sync error" pill.
- Lexend (rounded, playful) for text and SF Mono for numbers, 19 distinct font sizes, many 10 to 11 px all-caps tracked labels.
- Purple-tinted greys plus a pink gradient logo plus 5 pill colours. The light theme switches the accent to teal, so it feels like two brands.
- The logo lockup is 3 lines including the version number. 7 top tabs plus More.
- Mobile squeezes the desktop table: columns are cut off and prices are bigger than card names.

### Tokens, dark (default)

- Ground `#0B0B0E`, Sidebar `#0E0E12`, Surface `#131317`, Raised `#1B1B21`, Hover `#17171C`, Selected `#1C1A2A` with ring `#3A3360`
- Hairline `#1F1F25`, Hairline strong `#26262E`, Control border `#34343D`
- Text `#F5F5F7`, Text 2 `#B4B4BE`, Text 3 `#8C8C97` (the lightest grey allowed for small text, about 5:1 on Surface)
- Accent `#9F8CFF` (button text on it `#0B0B0E`), Accent line `#B3A5FF`, Accent link `#C4B8FF`, Accent soft `#221E3A`, active segment `#26243A`
- Gain `#34D399` on `#10261D`, Loss `#FB7185` on `#2A1419`, Attention `#F5C25B`
- Allocation segments are lightness steps of the accent: `#B3A5FF`, `#5E54A8`, `#3A3456`
- Grade labels are two-part chips (grader block, then grade block): PSA `#C9353B`/white then `#2A1518`/`#FFC2C5`. CGC `#2459D6`/white then `#15203A`/`#C3D4FF`. BGS `#C9A227`/`#1A1405` then `#2A230F`/`#F1D98A`. TAG `#F5F5F7`/`#0B0B0E` then `#1B1B21`/`#F5F5F7`.

### Tokens, light

- Ground `#F6F6F7`, Surface `#FFFFFF`, Text `#0B0B0E`, Accent `#5B4BD1` (replaces teal), Gain `#0F7A55`, Loss `#C7334A`. Derive the rest to match, checking 4.5:1 for body text.

### Type, shape, motion

- Geist for everything, with `font-variant-numeric: tabular-nums` on every number. Geist Mono only for cert numbers, set numbers and language tags. Google Fonts: `family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500`.
- Scale: Display 52/58 600 (-0.035em), Title 26/32 600 (-0.02em), Section 16/22 600, Body 14/20 400, Small 13/18, Caption 12/16 500. Sentence-case labels in Text 3, no all-caps tracking.
- Radii: cards 16, controls 10, chips full. 4 px spacing grid. Controls 40 px tall on desktop, at least 44 px touch targets on mobile.
- Motion: 160 ms ease-out for hover and press. Values roll on change. Skeleton placeholders instead of spinners. Respect `prefers-reduced-motion`.
- Colour lives on numbers and small dots, never on whole pills. Gains and losses always carry ▲ or ▼ and a sign, not colour alone.

### Screens

- **Desktop nav:** a left sidebar about 232 px wide replaces the top tabs. Logo lockup is the whale plus "Kujira" with "Collectibles" underneath. Groups: Overview. Collection (Singles, Slabs, Sealed, with counts). Selling (Listings, eBay, Sales, Dealer Desk). Workspace (Reports, Import, History, Trash, Guide). Footer: sync dot, "Synced 2 min ago · v3.xx" and a settings button. A sync error turns the dot red and makes it clickable; the permanent pill goes. It collapses to a 64 px icon rail on narrower screens.
- **Overview:** the header is the title plus "prices updated" time, a ⌘K search field and an "Add item" primary button. The hero card shows "Collection value" (total market) in Display size, a gain chip (market minus cost, with %) and "unrealised gain on S$X cost". Beside it a stats column: Cost basis, Realised profit (+ROI and number of sales), and Needs attention (for example Japanese cards on manual prices, unresolved numberless cards, pending settlement only when above 0). Below: "Top of the collection" (top 5 by market value across singles and slabs, shown as card or slab tiles), then three cards in a row: allocation bar, best and worst against cost (3 biggest % gains, 2 losses), and the 3 most recent sales. The Custom Chart Builder and AI Portfolio Analyst move, fully working, to a new Reports page. Remove the info icons and put the explanations in tooltips on the labels.
- **Collection (Singles, Slabs, Sealed):** header, Grid/List switch (remember per tab in localStorage) and an "Add card" button. A summary strip (Market value, Cost basis, Unrealised, Showing N cards · M units) that recalculates with filters. A toolbar with search, language chips with counts, a sort button and a Filters button. Grid tiles: art on a soft spotlight stage, with a ×qty badge and a language tag on the stage, then name, set, value, % change, and "Asking S$X" or "Manual price". The list view is a clean table: thumbnail with name and set, Lang, Qty, Cost, Market, Gain (amount and %), Asking, Added, and a "…" button shown on hover and focus. The per-column filter row hides behind the Filters button and keeps the `kjrMatchNumFilter` syntax.
- **Card inspector:** a side panel about 440 px wide (split view, so the list stays visible with the selected row highlighted) replaces opening the edit modal just to view a card. Top bar: "Card 1 of 12" with previous, next and close. Then a large art stage, name and set line, chips (language, condition, status dot, listing), and a value block (market value, gain against cost, a 30-day price line built from `priceHistory`, and the source line "TCGplayer market via TCGdex · checked today"). Then Bought, Held, Cost and Asking, a primary "Mark as sold", then List on eBay, Edit (open the existing modal at first) and "…". Esc closes the panel and ↑/↓ moves through cards. Date inputs must use `toIsoDateStr`.
- **Mobile:** header with whale, "Kujira", a search button and a settings button carrying a sync dot. Hero value with gain chip, sparkline and a 1M/3M/1Y/All control. A sideways-scrolling top-cards row. A Holdings list (thumbnail, name, set · language, value, % change) instead of the squeezed table. Bottom tab bar: Home, Collection, a raised round "+" in the middle, Sales, More.
- **Card art:** TCGdex card objects have an `image` base URL; append `/low.webp` for thumbnails and `/high.webp` for the inspector (`features.js` already does this for the launch intro). Look up the card once by `tcgdexId` and cache the image base locally (localStorage map from `tcgdexId` to image), NOT on the synced row and without `markDirty`, so phantom sync conflicts don't come back (see the v3.26 note in `CLAUDE.md`). Japanese, manual or unresolved cards get a neutral placeholder tile. Slabs are drawn as a slab: grey case, grader-coloured label bar showing grader and grade, card art inset.
- **Signature details (Step 6 or later):** a pointer-tracked holo shine on hover for top-of-collection tiles only, number roll, and a ⌘K palette that generalises the existing Quick Entry into search plus actions.

## 2. Plan (do one step at a time, show Julian, then continue)

1. **Tokens and type (start here).**
   - Remap `:root` and `html.light` in `styles.css` to the tokens above. Keep existing variable names so nothing breaks; add new ones only where needed.
   - Swap Lexend for Geist and Geist Mono in the `index.html` font link and `styles.css`. `.num` becomes Geist with tabular figures. Check the canvas `ctx.font` in `features.js` (about line 3969). Leave the xlsx export fonts alone.
   - Sweep the old purple hex values (`#12101F`, `#1A1730`, `#241E42`, `#2E2752`, `#8B7CF0`, `#7A6AE8`, `#A99DF5`, `#D4537E`) from inline styles in `index.html` and HTML built in JS, and replace them with variables.
   - Update `meta theme-color`, `Assets/manifest.webmanifest` colours, the `#intro` inline gradient, the auth-gate fallback, and any hard-coded Chart.js colours.
   - Remove the pink gradient on the "KUJIRA" logo text.
   - Convert all-caps tracked labels to sentence-case 12 to 13 px Text 3. Collapse font sizes towards the scale where it is safe.
   - Done when: both themes pass a contrast check, `./qc.sh` and `node --test` are green, screenshots are taken, and the version bump is ready but not shipped.
2. **Card images:** thumbnails in the Singles and Slabs lists, the grid view, and drawn slabs.
3. **Overview rebuild** and the new Reports page.
4. **Table cleanup:** filters behind a toggle, row actions behind "…", quiet tags, the summary strip.
5. **Card inspector** side panel.
6. **Sidebar nav, mobile Holdings rows and tab bar,** then the signature details.

## 3. Step 3 decision (answered 10/10/2026)

Julian said skip the chart. Build the Overview hero WITHOUT the value-over-time chart. That means the value, gain chip and side stats only, with no 1M/3M/1Y/All control. Following the fallback below, drop "Held N days" from the inspector too unless Julian asks for it.

### Original question

On 04/07/2026 `CLAUDE.md` recorded that Julian dropped a set of financial modules, including "mark-to-market history" and "inventory ageing". The Overview's value-over-time chart (market value against a stepped cost-basis line, 1M/3M/1Y/All, built from each item's `priceHistory` and `datePurchased`) and the inspector's "Held N days" overlap with those. Ask whether he wants them. If not, ship the hero without the chart (value, gain chip and side stats) and drop "Held".

## 4. Project essentials (from the gitignored CLAUDE.md, minus its security notes)

- **Files.** No framework, bundler or build step.
  - `index.html`: markup, the Sentry init, the theme pre-paint bootstrap and the Guide markdown.
  - `styles.css`: all CSS, with the cascade order preserved.
  - `app.js`: the modal controller and main app.
  - `features.js`: later features, including the launch intro (Three.js, vendored in `Assets/lib/`, toggled by `kujira_intro_enabled`).
  - `dealer-*.js`: the Dealer Desk.
  - Load order is load-bearing: `app.js` then `features.js` (then the dealer scripts) at the end of body, sharing one global scope.
  - `sw.js` caches assets cache-first. The new `?v=` URL is what busts caches.
- **Hosting.** PWA assets live at the repo root or in `Assets/`, never in `Server/`. `Server/worker.js` is the Cloudflare Worker source; leave it alone for UI work.
- **Tabs:** Dashboard, Singles, Slabs, Sales, eBay pipeline, Listings, Sealed (ETBs, booster boxes, packs), Import (CSV), Changelog, Trash, Guide, Dealer Desk.
- **Data.**
  - The in-memory `DB` is keyed by table (`singles`, `slabs`, `etbs`, `boosterBoxes`, `boosterPacks`, `ebay`, `sales`, `trash`, `changelog`). `saveData()` writes to localStorage, and Supabase is the cloud copy.
  - Call `markDirty(table, id)` whenever a row is created or changed.
  - Always `await saveAllToSupabase()` after bulk operations. Fire-and-forget loses data silently.
  - `kjrDeleteRow` always routes through `sendToTrash()`. Never hard-delete.
  - Call `snapshotForUndo()` before undoable writes.
  - Use `kjrEscape()` for any HTML built from data, `toIsoDateStr()` for `<input type="date">` values, and `toDateMmmYyyy()` for the stored "D MMM YYYY" form.
- **Pricing.**
  - Raw English singles are priced from TCGdex directly in the browser (`fetchPriceFromTcgdex`, `resolveTcgdexId`, the id cached on `item.tcgdexId`).
  - Japanese, Chinese, Indonesian and numberless singles are manual-only.
  - Slabs are priced by PPT through the Worker. Sealed is manual-only.
  - Results write onto the row as `marketPrice` plus `priceHistory` entries (`{date, price, unit, source, confidence}`). Read them with `getMkt(item)`.
  - Re-pricing to the same value must not `markDirty`, which avoids phantom sync conflicts.
  - Don't change any of this.
- **Preview guard.** A write skipped by `isLocalhostPreview()` must not clear dirty flags. Local previews never write to production.
- **Dropped modules.** Julian dropped financial modules M1 to M12 on 04/07/2026: monthly P&L, margin integrity, FX line, inventory ageing and velocity, capital in transit, repricing worklist, mark-to-market history, grading pipeline and EV, buyer analytics, concentration risk, restock quadrant and tax export. Don't rebuild them (see section 3).

## 5. Step 1 notes (done 10/10/2026 as v3.68)

Step 1 shipped on `redesign` as v3.68 on 10/10/2026. These notes stay as the record of the decisions.
- Extra changes beyond them:
  - form controls inherit the font and tabular figures
  - the active nav tab and the More trigger use `--accent-soft` with an accent icon
  - inline price inputs use Geist, not mono
  - light `--blue` is `#1868CC`
  - the sync pill tint is 8 to 10%
- Open from Step 1:
  - light hover-only pairs at 4.29 and 4.31
  - Chart Builder labels drawn in palette colours
  - Chart.js canvas font
  - Geist is not self-hosted
  - cert numbers are not mono yet
  - the listing description textarea is still mono

Step 2 shipped on `redesign` as v3.69 on 10/10/2026: card art, Grid/List and drawn slabs.

**Image storage (local only, never synced)**
- `kjr_card_images` in localStorage maps a `tcgdexId` (Japanese keys `ja:<id>`) to an image base, or a 7-day miss
- `kjr_slab_card_ids` links a slab to a card id. Slabs resolve read-only through `resolveTcgdexId` on a copy of the row

**How images get filled**
- `fetchPriceFromTcgdex` stores the image base as a side effect, wrapped so the price result can't change
- A lazy queue in features.js fills the rest: IntersectionObserver, 3 at once, 150 ms gap, waits while offline, pauses after 3 failures in a row, and no-ops without an observer

**Grid**
- Grid tiles are buttons with one delegated click per grid
- Grid/List prefs are `kjr_view_singles` and `kjr_view_slabs`, default list
- No selection or bulk actions in grid, the Columns button is hidden, and the grid follows the list's sort

**Tests:** tests/card-art.test.js has 33 tests.

**Open from Step 2**
- Dealer `focusCoreRow` doesn't highlight a card in grid view
- Slab art can pick another printing that shares the name and number
- Tested on 30 sample rows, not the live 788 singles and 159 slabs

Step 1 was paused on 09/10/2026 before any repo file changed. The baseline is `./qc.sh` PASS and `node --test` 807 tests, 801 pass, 0 fail, 6 skipped. The analysis below is done, so apply it rather than redoing it. The ratios were computed on draft values, so re-verify them against the real `styles.css`.

**Token decisions on top of section 1** (all checked at 4.5:1 or better)
- Dark tokens stay as section 1, plus:
  - `--accent2 #B3A5FF` (primary hover)
  - `--link #C4B8FF`
  - `--danger #C7334A` with `--danger-fg #FFFFFF` for filled destructive buttons, in both themes
  - `--font-sans` and `--font-mono` (Geist and Geist Mono stacks)
  - `--radius 10px`, `--radius-lg 16px`
  - shadows tinted with pure black
- Light theme as section 1, with these changes:
  - `--red-soft #FCECEF` (`#FBE9EC` fails at 4.49)
  - `--amber #946200` (`#9A6700` fails on its soft fill and on `--bg3`)
  - `--link #4A3BBF`, `--accent2 #4A3BBF`, `--accent-soft #ECE9FB`
  - Known weak spot: light `--text3` on `--bg4` is 4.26 (hover fills only)
- `--split-bar-fg`: dark `#0B0B0E`, light `#FFFFFF`. The `.inv-split-bar` fills are the light badge and grader tokens, and white on them fails in dark
- Category bars:
  - Dark `--cat1/2/3` `#6E5FD9`, `#4F43A8`, `#3A3170`. Light `#5B4BD1`, `#4535A8`, `#2E2475`. All pass with white
  - But `.exp-seg` (styles.css about 1152) and app.js about 13897-13899 darken them further with `color-mix(... black)`, and dark cat3 then renders `#262049`, nearly invisible. Decide in the browser whether to drop the mixes in both places together
- Dark badges and pills (fg on bg, border):
  - raw and sold: `#B4B4BE` on `#1B1B21`, `#2E2E36`
  - sealed and pending: `#F5C25B` on `#2A2312`, `#4D3E1A`
  - slab and traded: `#C4B8FF` on `#221E3A`, `#3A3360`
  - pristine: `#F1D98A` on `#2D2610` to `#241E0C`, `#5A4A1A`
  - stock and received: `#34D399` on `#10261D`, `#1B4A38`
  - grader tokens:
    - psa `#FF8F94` on `#2A1518`, `#4A2328`
    - cgc `#9DB8FF` on `#15203A`, `#24345A`
    - tag `#E4E4EA` on `#1B1B21`, `#34343D`
  - complete-summary borders: pos `#1B4A38`, neg `#54272F`, amber `#4D3E1A`
- Light badges and pills:
  - grader tokens:
    - psa `#B42B33` on `#FBE9EA`, `#F0BFC3`
    - cgc `#1D4FBF` on `#E7EEFC`, `#BCCDF3`
    - tag `#2E2E36` on `#F1F1F3`, `#CFCFD6`
  - raw and sold: `#4B4B55` on `#F1F1F3`, `#D4D4D8`
  - sealed and pending: `#946200` on `#FBF0D9`, `#E1CDA3`
  - slab and traded: `#4A3BBF` on `#ECE9FB`, `#C4BEEC`
  - pristine: `#6B4E00` on `#FBF1CF` to `#F5E6B3`, `#BE9A1F`
  - stock and received: `#0F7A55` on `#E3F4EC`, `#AED6C6`
  - complete-summary borders: pos `#AED6C6`, neg `#EFBEC6`, amber `#E1CDA3`
- `--red2` is unused today. If it stays, use dark `#E5485F`, light `#A82A3D`

**Sites to change** (line numbers approximate, from the 09/10 map)
- Filled destructive buttons to `--danger`: index.html about 379, 482, 559, app.js about 19521 (confirm `danger`), app.js about 19578 (toast Undo)
- White text on accent to `var(--accent-fg)`:
  - styles.css about 1289 `.sentry-badge`
  - features.js about 1470 (pipeline dot)
  - features.js about 1619 `.eb-tl-done`
- `a{}` uses `var(--link)`
- Monospace to `var(--font-mono)`:
  - styles.css 956, 1213, 1357, 1497, 1501, 1640
  - index.html 859, 1093, 1298
  - features.js 973, 974, 1075, 1076, 2099 (JS style string), 2719, 2720, 3096
  - app.js 8717, 11419-11421, 12767-12769, 15875, 15897, 15905, 15913, 15921
  - `.num` (styles.css 194) becomes `font-family:inherit`
- Fonts:
  - index.html Google Fonts link becomes Geist and Geist Mono, and `body` gets `var(--font-sans)` plus `font-variant-numeric:tabular-nums`
  - the auth gate (styles.css about 1259) and `#intro-skip` (about 1459) switch to Geist
  - features.js about 3969 `ctx.font` becomes Geist (the function is synchronous, so only change the string)
  - leave the ExcelJS `{name:'Lexend'}` alone
  - Geist loads 400 to 700, so `font-weight:800` renders at 700
- Logo:
  - index.html 173-178 has three spans (KUJIRA, Collectibles, `#app-ver`)
  - remove the gradient text rules (styles.css 91 and 93, including `-webkit-text-fill-color:transparent`)
  - change the text to `Kujira`
  - `span:last-child` (styles.css 92) wrongly uppercases `#app-ver`, so give the spans explicit classes
  - keep `id="app-ver"` on one line with the `>v3.68 (` shape, because qc.sh and misc-consistency parse it
- Brand chrome to `#0B0B0E` (light `#F6F6F7`):
  - index.html 14 `meta theme-color`
  - app.js about 18594-18597 runtime theme-color
  - manifest `background_color` and `theme_color`
  - `#intro` gradient (index.html 165 inline, styles.css 1446) to `#0B0B0E` then `#1B1B21`
  - auth gate fallback
  - leave the Three.js texture colours in features.js about 3950-4080 alone
- All-caps labels:
  - convert these rules to 12px, 500, `var(--text3)`, with no uppercase and no tracking: `th`, `.metric-label`, `.inv-stat-label`, mobile `thead th`, `.kjr-listing-table th`, `label.lbl`, `.kjr-modal .lbl`, `.sell-field label`, `.filters-label`, `.sell-cart-price-lbl`, `.sync-diag-label`, `.nav-dd-section`, `.sheet-section-label`, `.cmd-section-label`, `.guide-toc-title`, `.cmd-mode-tab`
  - convert the inline label uppercase too:
    - index.html 213, 649, 661, 671, 681, 766, 773, 849, 856, 1301, 1459
    - app.js 15874-15918, 18367, 17667, 18951, 10171
    - features.js 2419, 2493, 2502
  - make the change in CSS only, with no copy rewrites
  - leave `#intro-skip`, `.dealer-production-local` and the Sentry level tag as they are
- Odd font sizes in styles.css: 1203 (11.5 to 12), 1213-1215 (12.5 to 13), 1266 (17 to 16), 1288 (25), 1642 (23) to 22 or 26 by context
- Chart.js `CB_PALETTE` (app.js about 18784) and `palette` (about 14445) must stay 6-digit hex (fills are `color+'55'`):
  - Candidate, contrast-checked only: `#9F8CFF #F0C551 #D04A6D #5EC6B6 #2A6CC9 #FC9252 #3A8F4C #EDA4CC #4CAAD7 #C5DF66 #9F4CB1 #71CFD9`
  - Weak colour-blind pairs: 1-9, 3-7, 5-7, 2-10, 8-12
  - The AI chart takes the first 10
  - The `#161616` border fallback (about 19349) becomes `#131317`
  - Do not rerun a brute-force palette search, it ran past 10 minutes

**Version bump to 3.68** (same edit as the change)
- index.html 40 (Sentry release), 77 (styles.css tag), 177 (badge `v3.68 (DD Mon)`), 1957-1963 (7 scripts)
- sw.js 7 (`kujira-v70` to `kujira-v71`) and 13 (`CORE`)
- Do not touch `three.module.js?v=3.31`
- Tests pinned to the version that must move with it: tests/sw-update.test.js 8-14 (`v3.67 (5 Oct)`, `kujira-v70`, `?v=3.67`) and tests/dealer-production-preview.test.js 46 and 60 (`?v=3.67`)
- No test asserts on Lexend, uppercase, old hex values, `--red` or label text

**Browser check**
- The `collectibles` preview (port 3800) is already in the workspace-root `.claude/launch.json`
- Confirm the Google Fonts request succeeds in the pane, otherwise Geist rendering is unverified

**Seen outside Step 1, left for later steps**
- the AI Analyst chip gradient `#7c3aed` to `#4a9eff` (index.html 755)
- the auth kicker literal `KUJIRA` (index.html 84)
- inline semantic colours `#f59e0b`, `#22c55e` and `#ef4444` (14 or more app.js sites)
- the Pristine star `#f0b429` (app.js 13009)
- the chart legend literal `#999` (app.js 19397)
- the doughnut border stays near-black in light (app.js 19349)
