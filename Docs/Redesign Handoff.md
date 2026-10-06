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

## 3. Open question for Julian, ask before Step 3

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
