import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const HISTORICAL_FX = Object.freeze({
  rate: "1.2676",
  rateDate: "07/09/2026",
  rateSource: "MAS FX rate supplied in historical Price Review.md",
  status: "HISTORICAL_CALCULATION_ONLY"
});
export const CURRENT_SOURCE_LEDGER = Object.freeze({
  sourceRows: 103,
  posted: 93,
  excludedSold: 5,
  removed: 4,
  unavailable: 1,
  note: "Current source-row reconciliation, not a new listing or card count"
});
export const SUPERSEDED_SOURCE_LEDGER = Object.freeze({
  posted: 86,
  partial: 3,
  hold: 11,
  removed: 3,
  note: "Superseded historical status"
});
export const CANDIDATE_SCOPE = Object.freeze({
  historicalRows: 133,
  historicalLiveRows: 132,
  historicalPendingRows: 1,
  currentPublicProfileCountObserved: 167,
  requestedScopeCount: 57,
  requestedListingIds: null,
  snapshotDate: "07/09/2026 21:48:08 SGT",
  pricingRule: HISTORICAL_FX,
  currentSourceLedger: CURRENT_SOURCE_LEDGER,
  supersededSourceLedger: SUPERSEDED_SOURCE_LEDGER
});
export const CANDIDATE_SOURCE_PATH = "/Users/julianchow/.codex/worktrees/483e/Collectibles/Price Review.md";
export const CANDIDATE_PILOT_IDS = [
  "1459807033",
  "1459986557",
  "1459786398",
  "1459797036",
  "1459797377"
];
export const FOOTER = "*Disposable point-in-time doc. Delete once fully actioned (see AGENTS.md, Folder cleanliness).*";
export const MEETUP_VENUE = "Mui Thiang Kee Eating House, 34 Cassia Crescent, #01-86, 390034";
export const MEETUP_NOTE = "34 Cassia Crescent, Singapore 390034. Meet at Block 34.";
export const TARGET_CONTROLS = Object.freeze({
  fixedPriceOn: true,
  preOrderOn: false,
  meetupOn: true,
  officialDeliveryOn: false,
  buyButtonOn: false,
  buyerProtectionOn: false
});

const FIXED_BEFORE_CONTROLS = Object.freeze({
  fixedPriceOn: true,
  preOrderOn: false,
  meetupOn: true,
  officialDeliveryOn: true,
  buyButtonOn: true,
  buyerProtectionOn: true
});

export const CANDIDATE_PILOT_FACTS = Object.freeze({
  "1459807033": {
    grade: "TAG10",
    certificate: "Z7583128",
    priceSgd: 200,
    beforeSummary: "Fixed price S$420, Official Delivery and Buyer Protection shown publicly",
    beforeDescription: "Alakazam ex 203/165, Japanese Scarlet & Violet 151, 2023. Special Art Rare Holo.\n\nTAG 10 Gem Mint, certificate Z7583128. The photos show the actual slab, front and back. Please review the photos for the slab and protective sleeve condition.\n\nFixed price: S$420.\nMeet-up: 34 Cassia Crescent, Singapore 390034, Block 34.",
    hashtags: "#tag #pokemon #alakazam #pokemon151",
    body: "Pokemon Alakazam ex 203/165 Scarlet & Violet 151 Japanese Special Art Rare.",
    targetGrade: "TAG 10 Cert number: Z7583128.",
    beforePublicControls: { fixedPriceOn: true, preOrderOn: false, meetupOn: true, officialDeliveryOn: true, buyButtonOn: true, buyerProtectionOn: true }
  },
  "1459986557": {
    grade: "PSA9",
    certificate: "100703714",
    priceSgd: 296,
    beforeSummary: "Three-paragraph copy with tracked mail and Block 34 meetup shown publicly, saved switches unverified",
    beforeDescription: "Meetups at S390034. Tracked mail +$3. PSA 9 Cert number: 100703714.\n\nPokemon Arceus VSTAR GG70/GG70 Crown Zenith English Secret Rare.\n\n#psa #tag #pokemon #arceus #crownzenith #gg70",
    hashtags: "#psa #tag #pokemon #arceus #crownzenith #gg70",
    body: "Pokemon Arceus VSTAR GG70/GG70 Crown Zenith English Secret Rare.",
    targetGrade: "PSA 9 Cert number: 100703714.",
    beforePublicControls: { fixedPriceOn: true, preOrderOn: false, meetupOn: true, officialDeliveryOn: false, buyButtonOn: false, buyerProtectionOn: false }
  },
  "1459786398": {
    grade: "TAG10",
    certificate: "Y8343649",
    priceSgd: 150,
    beforeSummary: "Three-paragraph copy with tracked mail and Block 34 meetup shown publicly, saved switches unverified",
    beforeDescription: "Meetups at S390034. Tracked mail +$3. TAG 10 Cert number: Y8343649.\n\nPokemon Arceus V 267/S-P Japanese Pokémon Legends: Arceus Pre-Order Promo.\n\n#psa #tag #pokemon #arceus #pokemonlegendsarceus #promo",
    hashtags: "#psa #tag #pokemon #arceus #pokemonlegendsarceus #promo",
    body: "Pokemon Arceus V 267/S-P Pokémon Legends: Arceus Japanese Pre-Order Promo.",
    targetGrade: "TAG 10 Cert number: Y8343649.",
    beforePublicControls: { fixedPriceOn: true, preOrderOn: false, meetupOn: true, officialDeliveryOn: false, buyButtonOn: false, buyerProtectionOn: false }
  },
  "1459797036": {
    grade: "TAG9",
    certificate: "P6884835",
    priceSgd: 155,
    beforeSummary: "Fixed price S$210, Official Delivery and Buyer Protection shown publicly",
    beforeDescription: "Bulbasaur 143/142, English Stellar Crown, 2024. Illustration Rare Holo.\n\nTAG 9 Mint, certificate P6884835. The photos show the actual slab, front and back. Please review the photos for the slab and protective sleeve condition.\n\nFixed price: S$210.\nMeet-up: 34 Cassia Crescent, Singapore 390034, Block 34.",
    hashtags: "#tag #pokemon #bulbasaur #stellarCrown",
    body: "Pokemon Bulbasaur 143/142 Stellar Crown English Illustration Rare.",
    targetGrade: "TAG 9 Cert number: P6884835.",
    beforePublicControls: { fixedPriceOn: true, preOrderOn: false, meetupOn: true, officialDeliveryOn: true, buyButtonOn: true, buyerProtectionOn: true }
  },
  "1459797377": {
    grade: "TAG9",
    certificate: "R2796848",
    priceSgd: 155,
    beforeSummary: "Fixed price S$210, Official Delivery and Buyer Protection shown publicly",
    beforeDescription: "Bulbasaur 143/142, English Stellar Crown, 2024. Illustration Rare Holo.\n\nTAG 9 Mint, certificate R2796848. The photos show the actual slab, front and back. Please review the photos for the slab and protective sleeve condition.\n\nFixed price: S$210.\nMeet-up: 34 Cassia Crescent, Singapore 390034, Block 34.",
    hashtags: "#tag #pokemon #bulbasaur #stellarCrown",
    body: "Pokemon Bulbasaur 143/142 Stellar Crown English Illustration Rare.",
    targetGrade: "TAG 9 Cert number: R2796848.",
    beforePublicControls: { fixedPriceOn: true, preOrderOn: false, meetupOn: true, officialDeliveryOn: true, buyButtonOn: true, buyerProtectionOn: true },
    savedEditorProof: {
      status: "PARTIAL_VERIFIED",
      verifiedFields: ["preOrderOn", "fixedPriceOn", "meetupOn", "officialDeliveryOn", "buyButtonOn"],
      controls: {
        preOrderOn: false,
        fixedPriceOn: true,
        meetupOn: true,
        officialDeliveryOn: true,
        buyButtonOn: true
      },
      evidence: "Saved editor proof supplied by coordinator, no Update click"
    }
  }
});

export const CANDIDATE_CONFIG = Object.freeze({
  sourcePath: CANDIDATE_SOURCE_PATH,
  scope: CANDIDATE_SCOPE,
  pilotIds: CANDIDATE_PILOT_IDS,
  pilotFacts: CANDIDATE_PILOT_FACTS
});

export const FROZEN_PACKET_CONFIG = Object.freeze({
  sourcePath: CANDIDATE_SOURCE_PATH,
  scope: Object.freeze({
    historicalRows: 133,
    currentPublicProfileCountObserved: 167,
    requestedScopeCount: 57,
    requestedListingIds: null,
    pricingRule: HISTORICAL_FX,
    currentSourceLedger: CURRENT_SOURCE_LEDGER,
    supersededSourceLedger: SUPERSEDED_SOURCE_LEDGER
  }),
  pilotIds: CANDIDATE_PILOT_IDS,
  pilotFacts: Object.freeze(Object.fromEntries(CANDIDATE_PILOT_IDS.map(listingId => [
    listingId,
    Object.freeze({
      ...CANDIDATE_PILOT_FACTS[listingId],
      beforePublicControls: listingId === "1459986557" || listingId === "1459786398"
        ? { officialDeliveryOn: false, buyerProtectionOn: false }
        : { fixedPriceOn: true, officialDeliveryOn: true, buyerProtectionOn: true }
    })
  ])))
});

function resolveConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("review or packet configuration is required");
  if (!config.scope || typeof config.scope !== "object" || Array.isArray(config.scope)) throw new Error("scope configuration is required");
  if (!Array.isArray(config.pilotIds) || config.pilotIds.length === 0) throw new Error("pilot IDs configuration is required");
  if (new Set(config.pilotIds).size !== config.pilotIds.length || config.pilotIds.some(id => typeof id !== "string")) throw new Error("pilot IDs configuration must be unique strings");
  if (!config.pilotFacts || typeof config.pilotFacts !== "object" || Array.isArray(config.pilotFacts)) throw new Error("pilot facts configuration is required");
  config.pilotIds.forEach(id => {
    if (!config.pilotFacts[id] || typeof config.pilotFacts[id] !== "object" || Array.isArray(config.pilotFacts[id])) throw new Error("pilot fact missing for " + id);
  });
  return config;
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((out, key) => {
      if (value[key] !== undefined) out[key] = sortedValue(value[key]);
      return out;
    }, {});
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(sortedValue(value));
}

export function sha256(value) {
  const text = typeof value === "string" ? value : stableStringify(value);
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function digestJson(value) {
  return sha256(value);
}

export function cleanCell(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/<br\s*\/?>/gi, "\n").trim();
}

export function parseMoneyCell(value) {
  const text = cleanCell(value).replace(/\s+/g, " ");
  if (!text || text === "-" || /^n\/?a$/i.test(text)) return null;
  const match = text.match(/^(?:S?\$)?([0-9]+(?:\.[0-9]{1,2})?)$/);
  if (!match) throw new Error("Invalid money cell: " + JSON.stringify(value));
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Invalid money cell: " + JSON.stringify(value));
  }
  return amount;
}

function decimalUnits(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(text)) throw new Error("Invalid decimal " + label);
  const parts = text.split(".");
  return {
    units: BigInt(parts[0] + (parts[1] || "")),
    scale: 10n ** BigInt((parts[1] || "").length)
  };
}

function ceilRational(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

export function roundAllowedEnding(value) {
  const parsed = decimalUnits(value, "amount");
  let integer = ceilRational(parsed.units, parsed.scale);
  while (![0n, 2n, 5n, 8n].includes(integer % 10n)) integer += 1n;
  if (integer > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Rounded amount exceeds safe integer range");
  return Number(integer);
}

export function computeSuggestedPrice(usd, rate, metadata = {}) {
  const usdValue = decimalUnits(usd, "USD");
  const rateValue = decimalUnits(rate, "FX rate");
  if (usdValue.units <= 0n) throw new Error("USD amount must be greater than zero");
  if (rateValue.units <= 0n) throw new Error("FX rate must be greater than zero");
  if (typeof metadata.rateDate !== "string" || !/^\d{2}\/\d{2}\/\d{4}$/.test(metadata.rateDate)) throw new Error("FX rate date must be DD/MM/YYYY");
  const dateParts = metadata.rateDate.split("/").map(Number);
  const dateCheck = new Date(Date.UTC(dateParts[2], dateParts[1] - 1, dateParts[0]));
  if (dateCheck.getUTCFullYear() !== dateParts[2] || dateCheck.getUTCMonth() !== dateParts[1] - 1 || dateCheck.getUTCDate() !== dateParts[0]) {
    throw new Error("FX rate date must be a real date");
  }
  if (typeof metadata.rateSource !== "string" || !metadata.rateSource.trim()) throw new Error("FX rate source is required");
  const numerator = usdValue.units * rateValue.units * 130n;
  const denominator = usdValue.scale * rateValue.scale * 100n;
  const preEndingSgd = ceilRational(numerator, denominator);
  const priceSgd = roundAllowedEnding(preEndingSgd.toString());
  return {
    priceSgd,
    usd: String(usd),
    rate: String(rate),
    markup: 1.3,
    rateDate: metadata.rateDate,
    rateSource: metadata.rateSource,
    calculation: "USD * dated FX rate * 1.30, full precision, then smallest integer at an allowed ending 0, 2, 5 or 8",
    calculationOnly: true,
    liveFxVerified: false,
    notApproved: true
  };
}

export function splitTableRow(line) {
  const text = line.trim();
  if (!text.startsWith("|")) return [];
  const body = text.endsWith("|") ? text.slice(1, -1) : text.slice(1);
  return body.split("|").map(cleanCell);
}

function firstLink(cell) {
  const match = cleanCell(cell).match(/\[[^\]]*\]\(([^)]+)\)/);
  return match ? match[1].trim() : null;
}

export function extractListingId(value) {
  const matches = String(value ?? "").match(/\d{7,}/g);
  return matches && matches.length ? matches[matches.length - 1] : null;
}

export function canonicalCarousellUrl(value, expectedId = null) {
  if (!value) return null;
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "www.carousell.sg") return null;
  const match = url.pathname.match(/-(\d{7,})\/?$/);
  if (!match || (expectedId && match[1] !== expectedId)) return null;
  return "https://www.carousell.sg" + url.pathname.replace(/\/?$/, "/");
}

function headerMap(cells) {
  const map = {};
  cells.forEach((cell, index) => {
    const label = cleanCell(cell).toLowerCase();
    if (label === "card" || label.includes("item")) map.card ??= index;
    if (label.includes("grade")) map.grade ??= index;
    if (label.includes("certificate") || label === "cert") map.certificate ??= index;
    if (label.includes("condition")) map.condition ??= index;
    if (label.includes("converted pc") || label.includes("market")) map.convertedPc ??= index;
    if (label === "pricecharting" || label.includes("pricecharting url")) map.priceChartingLink = index;
    if (label.includes("decided")) map.decided = index;
    if (label === "carousell" || label.includes("listing")) map.listing = index;
    if (label.includes("upload")) map.upload ??= index;
  });
  return map;
}

export function parseReviewMarkdown(markdown) {
  const rows = [];
  let status = "LIVE";
  let columns = null;
  const lines = String(markdown).split(/\r?\n/);
  lines.forEach((line, lineIndex) => {
    if (/^##\s+pending\b/i.test(line.trim())) {
      status = "PENDING";
      columns = null;
    }
    if (!line.trim().startsWith("|")) return;
    const cells = splitTableRow(line);
    if (cells.length < 7 || cells.every(cell => /^:?-{2,}:?$/.test(cell))) return;
    const possible = headerMap(cells);
    if (possible.card !== undefined && (possible.listing !== undefined || /card/i.test(cells[0]))) {
      columns = possible;
      return;
    }
    if (!columns) return;
    const card = cleanCell(cells[columns.card ?? 0]);
    const listingCell = cells[columns.listing ?? cells.length - 1] ?? "";
    const rawListingUrl = firstLink(listingCell) || (/^https?:\/\//.test(listingCell) ? listingCell : null);
    const listingId = extractListingId(rawListingUrl || listingCell);
    if (!card || !listingId) return;
    const listingUrl = canonicalCarousellUrl(rawListingUrl, listingId);
    if (!listingUrl) throw new Error("Price Review.md line " + (lineIndex + 1) + ": invalid Carousell listing URL");
    const marketCell = columns.convertedPc === undefined ? "" : cells[columns.convertedPc];
    const decidedCell = columns.decided === undefined ? "" : cells[columns.decided];
    let market = null;
    let decided = null;
    try {
      market = marketCell ? parseMoneyCell(marketCell) : null;
      decided = decidedCell ? parseMoneyCell(decidedCell) : null;
    } catch (error) {
      throw new Error("Price Review.md line " + (lineIndex + 1) + ": " + error.message);
    }
    rows.push({
      sourceLine: lineIndex + 1,
      status,
      card,
      grade: cleanCell(columns.grade === undefined ? "" : cells[columns.grade]),
      certificate: cleanCell(columns.certificate === undefined ? "" : cells[columns.certificate]),
      condition: cleanCell(columns.condition === undefined ? "" : cells[columns.condition]),
      convertedPcSgd: market,
      priceChartingUrl: firstLink(columns.priceChartingLink === undefined ? "" : cells[columns.priceChartingLink]),
      decidedPriceSgd: decided,
      listingId,
      listingUrl,
      uploadStatus: cleanCell(columns.upload === undefined ? "" : cells[columns.upload])
    });
  });
  return rows;
}

export function assertCanonicalReview(review, expectedScope) {
  const errors = [];
  if (!expectedScope || typeof expectedScope !== "object") errors.push("expected scope configuration is required");
  if (!review || review.schemaVersion !== 1) errors.push("wrong canonical review schema");
  const rows = review?.rows;
  if (!Array.isArray(rows)) errors.push("canonical rows missing");
  if (Array.isArray(rows)) {
    if (expectedScope && rows.length !== expectedScope.historicalRows) errors.push("historical row count mismatch, got " + rows.length);
    const ids = rows.map(row => row.listingId);
    if (new Set(ids).size !== ids.length) errors.push("duplicate listing ID in canonical rows");
    if (expectedScope) {
      if (expectedScope.historicalLiveRows !== undefined && rows.filter(row => row.status === "LIVE").length !== expectedScope.historicalLiveRows) errors.push("historical live row count mismatch");
      if (expectedScope.historicalPendingRows !== undefined && rows.filter(row => row.status === "PENDING").length !== expectedScope.historicalPendingRows) errors.push("historical pending row count mismatch");
    }
    rows.forEach(row => {
      if (!/^\d{7,}$/.test(row.listingId)) errors.push("invalid listing ID " + row.listingId);
      if (row.decidedPriceSgd !== null && !Number.isFinite(row.decidedPriceSgd)) errors.push("invalid decided price " + row.listingId);
      if (canonicalCarousellUrl(row.listingUrl, row.listingId) !== row.listingUrl) errors.push("non-canonical listing URL " + row.listingId);
    });
  }
  if (expectedScope && stableStringify(review?.scope) !== stableStringify(expectedScope)) errors.push("review scope does not match supplied scope configuration");
  if (errors.length) throw new Error(errors.join("; "));
  return true;
}

export async function buildCanonicalReview({ sourcePath, scope } = {}) {
  if (!sourcePath) throw new Error("sourcePath is required");
  if (!scope) throw new Error("scope configuration is required");
  const source = await fs.readFile(sourcePath, "utf8");
  const stat = await fs.stat(sourcePath);
  const rows = parseReviewMarkdown(source);
  const review = {
    schemaVersion: 1,
    kind: "CAROUSELL_CANONICAL_REVIEW",
    source: {
      path: sourcePath,
      sha256: sha256(source),
      fileMtime: stat.mtime.toISOString(),
      snapshotDate: scope.snapshotDate || null
    },
    scope: { ...scope },
    rows
  };
  assertCanonicalReview(review, scope);
  return review;
}

function escapePipe(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function canonicalReviewMarkdown(review) {
  assertCanonicalReview(review, review?.scope);
  const out = [
    "# Review Table",
    "",
    "Historical Carousell pricing review, parsed from the read-only 483e Price Review.md source.",
    "",
    "Source SHA256: " + review.source.sha256,
    "Source snapshot: " + review.source.snapshotDate,
    "Historical scope: " + review.scope.historicalRows + " rows, " + review.scope.historicalLiveRows + " live and " + review.scope.historicalPendingRows + " pending. Current public profile observation: " + review.scope.currentPublicProfileCountObserved + " unique IDs. Requested scope: " + review.scope.requestedScopeCount + ", canonical ID set unresolved.",
    "Current source ledger: " + review.scope.currentSourceLedger.sourceRows + " rows, " + review.scope.currentSourceLedger.posted + " posted, " + review.scope.currentSourceLedger.excludedSold + " excluded or sold, " + review.scope.currentSourceLedger.removed + " removed and " + review.scope.currentSourceLedger.unavailable + " unavailable. Superseded status was " + review.scope.supersededSourceLedger.posted + " posted, " + review.scope.supersededSourceLedger.partial + " partial, " + review.scope.supersededSourceLedger.hold + " hold and " + review.scope.supersededSourceLedger.removed + " removed.",
    "",
    "| Status | Card | Grade | Certificate | Converted PC S$ | Decided S$ | Listing ID | Listing URL | Upload status |",
    "|---|---|---|---|---:|---:|---:|---|---|"
  ];
  review.rows.forEach(row => {
    const market = row.convertedPcSgd === null ? "" : row.convertedPcSgd.toFixed(2);
    const decided = row.decidedPriceSgd === null ? "" : row.decidedPriceSgd.toFixed(2);
    out.push("| " + [
      row.status,
      escapePipe(row.card),
      escapePipe(row.grade),
      escapePipe(row.certificate),
      market,
      decided,
      row.listingId,
      row.listingUrl || "",
      escapePipe(row.uploadStatus)
    ].join(" | ") + " |");
  });
  out.push("", FOOTER, "");
  return out.join("\n");
}

function targetDescription(fact) {
  const tags = [...new Set(["#psa", "#tag", "#pokemon", ...fact.hashtags.split(/\s+/).filter(Boolean)])];
  return "Meetups at S390034. Tracked mail +$3. " + fact.targetGrade + "\n\n" + fact.body + "\n\n" + tags.join(" ");
}

function itemDigest(item) {
  const base = {
    listingId: item.listingId,
    identityUrl: item.identityUrl,
    card: item.card,
    grade: item.grade,
    certificate: item.certificate,
    before: item.before,
    after: item.after,
    gates: item.gates
  };
  return {
    beforeSha256: sha256(item.before),
    afterSha256: sha256(item.after),
    itemSha256: sha256(base)
  };
}

function packetBody(packet) {
  const body = packet && typeof packet === "object" ? structuredClone(packet) : {};
  if (body.integrity) delete body.integrity.packetContentSha256;
  return body;
}

export function buildPilotPacket(review, config) {
  const cfg = resolveConfig(config);
  assertCanonicalReview(review, cfg.scope);
  const byId = new Map(review.rows.map(row => [row.listingId, row]));
  const items = cfg.pilotIds.map(listingId => {
    const row = byId.get(listingId);
    const fact = cfg.pilotFacts[listingId];
    if (!row) throw new Error("Pilot listing missing from canonical review: " + listingId);
    const afterDescription = targetDescription(fact);
    const editorProof = fact.savedEditorProof || {
      status: "UNVERIFIED",
      verifiedFields: [],
      controls: null,
      evidence: "No saved editor proof supplied"
    };
    const before = {
      observed: true,
      identityUrl: row.listingUrl,
      priceSgd: fact.priceSgd,
      description: fact.beforeDescription,
      descriptionSummary: fact.beforeSummary,
      publicControls: fact.beforePublicControls,
      editorControls: editorProof.controls,
      editorEvidence: editorProof
    };
    const after = {
      priceSgd: fact.priceSgd,
      description: afterDescription,
      controls: TARGET_CONTROLS,
      meetupVenue: MEETUP_VENUE,
      meetupNote: MEETUP_NOTE
    };
    const item = {
      listingId,
      identityUrl: row.listingUrl,
      card: row.card,
      grade: fact.grade,
      certificate: fact.certificate,
      before,
      after,
      gates: {
        savedEditorSwitches: editorProof.status,
        photoCertificatePixelComparison: "UNVERIFIED",
        publicationApproval: "NOT_GRANTED",
        browserExecutor: "NOT_RUN",
        publicAfterChange: "NOT_RUN"
      }
    };
    item.integrity = itemDigest(item);
    return item;
  });
  const packet = {
    schemaVersion: 1,
    kind: "CAROUSELL_PILOT_CHANGE_PACKET",
    status: "PROPOSED_LOCAL_ONLY",
    generatedAt: new Date().toISOString(),
    sourceScope: {
      sourcePath: review.source.path,
      sourceSha256: review.source.sha256,
      ...review.scope,
      note: "This is a proposed " + cfg.pilotIds.length + "-listing packet. It does not establish the requested " + (cfg.scope.requestedScopeCount ?? "configured") + "-ID canonical set."
    },
    venue: { picker: MEETUP_VENUE, note: MEETUP_NOTE },
    targetControls: TARGET_CONTROLS,
    items,
    gates: {
      savedEditorSwitches: "PARTIAL, only 1459797377 has supplied saved proof",
      photoCertificatePixelComparison: "UNVERIFIED",
      publicationApproval: "NOT_GRANTED",
      browserExecutor: "NOT_RUN",
      publicAfterChange: "NOT_RUN"
    },
    integrity: {},
    note: "Generated once with create-only output. Content hash checks integrity, it is not an OS-immutable or signed approval.",
    footer: FOOTER
  };
  packet.integrity.packetContentSha256 = sha256(packetBody(packet));
  assertPilotPacket(packet, cfg);
  return packet;
}

export function assertPilotPacket(packet, config) {
  const errors = [];
  let cfg;
  try {
    cfg = resolveConfig(config);
  } catch (error) {
    errors.push(error.message);
  }
  if (!packet || packet.schemaVersion !== 1 || packet.kind !== "CAROUSELL_PILOT_CHANGE_PACKET") errors.push("wrong packet schema");
  if (packet?.status !== "PROPOSED_LOCAL_ONLY") errors.push("packet is not proposed local only");
  if (cfg) Object.entries(cfg.scope).forEach(([key, value]) => {
    if (stableStringify(packet?.sourceScope?.[key]) !== stableStringify(value)) errors.push("packet source scope mismatch " + key);
  });
  if (JSON.stringify(packet?.targetControls) !== JSON.stringify(TARGET_CONTROLS)) errors.push("packet target controls mismatch");
  const items = packet?.items;
  if (!Array.isArray(items) || !cfg || items.length !== cfg.pilotIds.length) errors.push("packet must contain exactly " + (cfg?.pilotIds.length ?? "configured") + " items");
  if (Array.isArray(items)) {
    const ids = items.map(item => item && typeof item === "object" ? item.listingId : null);
    if (cfg && JSON.stringify(ids) !== JSON.stringify(cfg.pilotIds)) errors.push("packet IDs are wrong, missing, or reordered");
    if (new Set(ids).size !== ids.length) errors.push("packet contains duplicate IDs");
    items.forEach(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push("packet item must be an object");
        return;
      }
      const fact = cfg?.pilotFacts?.[item.listingId];
      if (!fact) {
        errors.push("unexpected packet ID " + item.listingId);
        return;
      }
      if (item.certificate !== fact.certificate) errors.push("certificate mismatch " + item.listingId);
      if (item.grade !== fact.grade) errors.push("grade mismatch " + item.listingId);
      if (item.before?.priceSgd !== fact.priceSgd || item.after?.priceSgd !== fact.priceSgd) errors.push("price mismatch " + item.listingId);
      if (stableStringify(item.before?.publicControls) !== stableStringify(fact.beforePublicControls)) errors.push("before public controls mismatch " + item.listingId);
      if (item.after?.description !== targetDescription(fact)) errors.push("description mismatch " + item.listingId);
      if (JSON.stringify(item.after?.controls) !== JSON.stringify(TARGET_CONTROLS)) errors.push("target controls mismatch " + item.listingId);
      if (item.after?.meetupVenue !== MEETUP_VENUE || item.after?.meetupNote !== MEETUP_NOTE) errors.push("meetup mismatch " + item.listingId);
      const digest = itemDigest(item);
      if (JSON.stringify(item.integrity) !== JSON.stringify({
        beforeSha256: digest.beforeSha256,
        afterSha256: digest.afterSha256,
        itemSha256: digest.itemSha256
      })) errors.push("item digest mismatch " + item.listingId);
      if (canonicalCarousellUrl(item.identityUrl, item.listingId) !== item.identityUrl) errors.push("identity URL mismatch " + item.listingId);
      if (!item.gates || item.gates.publicationApproval !== "NOT_GRANTED" || item.gates.photoCertificatePixelComparison !== "UNVERIFIED" || item.gates.browserExecutor !== "NOT_RUN" || item.gates.publicAfterChange !== "NOT_RUN") {
        errors.push("packet gate status changed " + item.listingId);
      }
    });
  }
  if (packet && typeof packet === "object" && packet.integrity?.packetContentSha256 !== sha256(packetBody(packet))) errors.push("packet content digest mismatch");
  if (errors.length) throw new Error(errors.join("; "));
  return true;
}

function fencedText(value) {
  const fence = String.fromCharCode(96).repeat(3);
  return fence + "\n" + String(value ?? "(not available in source evidence)") + "\n" + fence;
}

export function pilotPacketMarkdown(packet, config) {
  assertPilotPacket(packet, config);
  const out = [
    "# Pilot Packet",
    "",
    "Status: " + packet.status,
    "Packet content SHA256: " + packet.integrity.packetContentSha256,
    "Historical source: " + packet.sourceScope.historicalRows + " rows, source SHA256 " + packet.sourceScope.sourceSha256,
    "Current public profile observation: " + packet.sourceScope.currentPublicProfileCountObserved + " unique IDs",
    "Requested scope: " + packet.sourceScope.requestedScopeCount + ", canonical ID set unresolved",
    "",
    "| **Listing ID** | **Card** | **Grade** | **Certificate** | **Proposed S$** | **Identity URL** |",
    "|---:|---|:---:|---|---:|---|"
  ];
  packet.items.forEach(item => {
    out.push("| " + [
      item.listingId,
      escapePipe(item.card),
      item.grade,
      item.certificate,
      item.after.priceSgd.toFixed(2),
      item.identityUrl
    ].join(" | ") + " |");
  });
  packet.items.forEach(item => {
    out.push(
      "",
      "## " + item.listingId,
      "",
      "Card: " + item.card,
      "Grade: " + item.grade,
      "Certificate: " + item.certificate,
      "Identity URL: " + item.identityUrl,
      "",
      "**Before price S$** " + item.before.priceSgd.toFixed(2),
      "",
      "**Before description**",
      "",
      fencedText(item.before.description),
      "",
      "**Proposed price S$** " + item.after.priceSgd.toFixed(2),
      "",
      "**After description**",
      "",
      fencedText(item.after.description),
      "",
      "Controls: fixed price on, pre-order off, meetup on, Official Delivery off, Buy off, Buyer Protection off",
      "Meetup picker: " + item.after.meetupVenue,
      "Meetup note: " + item.after.meetupNote,
      "Gates: saved editor switches " + item.gates.savedEditorSwitches + ", photo and certificate comparison " + item.gates.photoCertificatePixelComparison + ", publication approval " + item.gates.publicationApproval + ", browser executor " + item.gates.browserExecutor + ", public after-change check " + item.gates.publicAfterChange
    );
  });
  out.push("", "This packet is a proposed local change set. Its content hash checks integrity, it is not an OS-immutable or signed approval.", "", FOOTER, "");
  return out.join("\n");
}

export function receiptTemplate(packet, config) {
  assertPilotPacket(packet, config);
  return {
    schemaVersion: 1,
    kind: "CAROUSELL_EXECUTOR_RECEIPT",
    status: "EMPTY_TEMPLATE",
    packetContentSha256: packet.integrity.packetContentSha256,
    receipts: [],
    requiredReceiptFields: [
      "before observed identity card grade certificate price description controls evidenceRef",
      "save attempted outcome evidenceRef",
      "reopen observed valuesMatch identity price description controls evidenceRef",
      "public observed identity price description controls evidenceRef",
      "after observed identity price description controls meetupVenue meetupNote evidenceRef"
    ],
    failClosed: true,
    note: "An empty, synthetic, or unapproved receipt never proves a saved listing change."
  };
}

const CONTROL_KEYS = Object.keys(TARGET_CONTROLS);
function checkControls(actual, expected, label, errors) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    errors.push(label + " missing");
    return;
  }
  CONTROL_KEYS.forEach(key => {
    if (typeof actual[key] !== "boolean") errors.push(label + "." + key + " must be boolean");
    else if (expected && expected[key] !== undefined && actual[key] !== expected[key]) errors.push(label + "." + key + " mismatch");
  });
  Object.keys(actual).forEach(key => {
    if (!CONTROL_KEYS.includes(key)) errors.push(label + " has unexpected control " + key);
  });
}

function checkEvidence(value, label, errors) {
  if (!value || value.observed !== true || typeof value.evidenceRef !== "string" || !value.evidenceRef) {
    errors.push(label + " lacks observed evidenceRef");
  }
}

function rejectSyntheticReference(value, label, errors) {
  if (typeof value === "string" && /^synthetic-test:\/\//i.test(value)) errors.push(label + " uses synthetic evidence");
}

function checkIdentity(value, item, label, errors) {
  if (!value || canonicalCarousellUrl(value.identityUrl, item.listingId) !== item.identityUrl || value.identityUrl !== item.identityUrl) {
    errors.push(label + " identity URL mismatch");
  }
  if (value?.card !== item.card) errors.push(label + " card mismatch");
  if (value?.grade !== item.grade) errors.push(label + " grade mismatch");
  if (value?.certificate !== item.certificate) errors.push(label + " certificate mismatch");
}

function receiptBody(receipt) {
  const body = structuredClone(receipt);
  delete body.integrity?.receiptSha256;
  return body;
}

export function validateExecutorReceipts(packet, document, config) {
  const errors = [];
  let cfg;
  try {
    cfg = resolveConfig(config);
  } catch (error) {
    errors.push(error.message);
  }
  try {
    assertPilotPacket(packet, cfg);
  } catch (error) {
    errors.push("packet rejected: " + error.message);
  }
  if (!document || typeof document !== "object") {
    return { ok: false, errors: ["receipt document missing"] };
  }
  if (document.status === "EMPTY_TEMPLATE" || document.status === "SYNTHETIC" || document.synthetic === true || document.fixtureLabel === "SYNTHETIC") {
    errors.push("empty or synthetic receipts are never accepted");
  }
  if (document.kind !== "CAROUSELL_EXECUTOR_RECEIPT" || document.schemaVersion !== 1) errors.push("wrong receipt schema");
  const structuralOnly = document.status === "STRUCTURAL_VALIDATION_ONLY";
  const liveVerified = document.status === "LIVE_VERIFIED";
  if (!structuralOnly && !liveVerified) errors.push("receipt status must be STRUCTURAL_VALIDATION_ONLY or LIVE_VERIFIED");
  if (document.packetContentSha256 !== packet?.integrity?.packetContentSha256) errors.push("receipt packet digest mismatch");
  if (!Array.isArray(document.receipts) || !cfg || document.receipts.length !== cfg.pilotIds.length) {
    errors.push("receipt membership must contain exactly " + (cfg?.pilotIds.length ?? "configured") + " rows");
    return { ok: false, errors: [...new Set(errors)] };
  }
  const counts = new Map();
  document.receipts.forEach(receipt => {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      errors.push("receipt row must be an object");
      return;
    }
    counts.set(receipt.listingId, (counts.get(receipt.listingId) || 0) + 1);
  });
  cfg?.pilotIds.forEach(id => {
    if ((counts.get(id) || 0) !== 1) errors.push("receipt missing or duplicate ID " + id);
  });
  counts.forEach((count, id) => {
    if (!cfg?.pilotIds.includes(id)) errors.push("receipt unexpected ID " + id);
    if (count > 1) errors.push("receipt duplicate ID " + id);
  });
  document.receipts.forEach(receipt => {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return;
    const packetItems = Array.isArray(packet?.items) ? packet.items : [];
    const item = packetItems.find(candidate => candidate.listingId === receipt.listingId);
    if (!item) return;
    if (receipt.packetItemSha256 !== item.integrity.itemSha256) errors.push(receipt.listingId + " packet item digest mismatch");
    if (!receipt.integrity?.receiptSha256 || receipt.integrity.receiptSha256 !== sha256(receiptBody(receipt))) errors.push(receipt.listingId + " receipt digest mismatch");
    const before = receipt.before;
    checkEvidence(before, receipt.listingId + " before", errors);
    checkIdentity(before, item, receipt.listingId + " before", errors);
    if (before?.priceSgd !== item.before.priceSgd) errors.push(receipt.listingId + " before price mismatch");
    if (before?.description !== item.before.description) errors.push(receipt.listingId + " before copy mismatch");
    checkControls(before?.controls, null, receipt.listingId + " before controls", errors);
    const expectedEditor = item.before.editorControls;
    if (expectedEditor) Object.entries(expectedEditor).forEach(([key, value]) => {
      if (before?.controls?.[key] !== value) errors.push(receipt.listingId + " before saved control mismatch " + key);
    });
    if (!receipt.save || receipt.save.attempted !== true || receipt.save.outcome !== "SAVED" || typeof receipt.save.evidenceRef !== "string" || !receipt.save.evidenceRef) {
      errors.push(receipt.listingId + " save evidence missing or not SAVED");
    }
    const targetSteps = [
      ["reopen", receipt.reopen],
      ["public", receipt.public],
      ["after", receipt.after]
    ];
    targetSteps.forEach(([label, step]) => {
      checkEvidence(step, receipt.listingId + " " + label, errors);
      checkIdentity(step, item, receipt.listingId + " " + label, errors);
      if (label === "reopen" && step?.valuesMatch !== true) errors.push(receipt.listingId + " reopen valuesMatch missing");
      if (step?.priceSgd !== item.after.priceSgd) errors.push(receipt.listingId + " " + label + " price mismatch");
      if (step?.description !== item.after.description) errors.push(receipt.listingId + " " + label + " copy mismatch");
      checkControls(step?.controls, TARGET_CONTROLS, receipt.listingId + " " + label + " controls", errors);
    });
    if (liveVerified) {
      if (typeof before?.freshBeforeEvidenceRef !== "string" || !before.freshBeforeEvidenceRef) errors.push(receipt.listingId + " fresh before proof missing");
      if (before?.photoCertificateComparison !== "VERIFIED") errors.push(receipt.listingId + " photo and certificate proof missing");
      rejectSyntheticReference(before?.evidenceRef, receipt.listingId + " before", errors);
      rejectSyntheticReference(before?.freshBeforeEvidenceRef, receipt.listingId + " fresh before", errors);
      rejectSyntheticReference(receipt.save?.evidenceRef, receipt.listingId + " save", errors);
      rejectSyntheticReference(receipt.reopen?.evidenceRef, receipt.listingId + " reopen", errors);
      rejectSyntheticReference(receipt.public?.evidenceRef, receipt.listingId + " public", errors);
      rejectSyntheticReference(receipt.after?.evidenceRef, receipt.listingId + " after", errors);
    }
    if (receipt.after?.meetupVenue !== MEETUP_VENUE || receipt.after?.meetupNote !== MEETUP_NOTE) errors.push(receipt.listingId + " after meetup mismatch");
  });
  if (liveVerified) {
    if (typeof document.approvalReference !== "string" || !document.approvalReference) errors.push("publication approval reference missing");
    rejectSyntheticReference(document.approvalReference, "publication approval", errors);
    if (document.approvalPacketContentSha256 !== packet?.integrity?.packetContentSha256) errors.push("approval is not bound to packet digest");
    if (document.photoCertificateComparison?.status !== "VERIFIED" || document.photoCertificateComparison?.packetContentSha256 !== packet?.integrity?.packetContentSha256 || typeof document.photoCertificateComparison?.evidenceRef !== "string" || !document.photoCertificateComparison.evidenceRef) {
      errors.push("fresh photo and certificate comparison is not bound to packet digest");
    }
    rejectSyntheticReference(document.photoCertificateComparison?.evidenceRef, "photo and certificate comparison", errors);
  }
  return {
    ok: errors.length === 0,
    completion: false,
    requiresIndependentReview: true,
    status: structuralOnly ? "STRUCTURAL_VALIDATION_ONLY" : (liveVerified ? "LIVE_EVIDENCE_STRUCTURE" : "REJECTED"),
    errors: [...new Set(errors)]
  };
}

export async function generateOutputs({ outputDir, sourcePath, scope, packetConfig } = {}) {
  if (!outputDir) throw new Error("output directory is required");
  if (!sourcePath) throw new Error("input source path is required");
  if (!scope) throw new Error("scope configuration is required");
  const cfg = resolveConfig(packetConfig);
  if (stableStringify(cfg.scope) !== stableStringify(scope)) throw new Error("packet configuration scope does not match supplied scope");
  if (cfg.sourcePath && path.resolve(cfg.sourcePath) !== path.resolve(sourcePath)) throw new Error("packet configuration source path does not match supplied input");
  const review = await buildCanonicalReview({ sourcePath, scope });
  const packet = buildPilotPacket(review, cfg);
  const template = receiptTemplate(packet, cfg);
  const outputs = [
    ["Review Table.json", JSON.stringify(review, null, 2) + "\n"],
    ["Review Table.md", canonicalReviewMarkdown(review)],
    ["Pilot Packet.json", JSON.stringify(packet, null, 2) + "\n"],
    ["Pilot Packet.md", pilotPacketMarkdown(packet, cfg)],
    ["Receipt Template.json", JSON.stringify(template, null, 2) + "\n"]
  ];
  await fs.mkdir(outputDir, { recursive: true });
  for (const [name] of outputs) {
    try {
      await fs.access(path.join(outputDir, name));
      throw new Error("Refusing to overwrite existing output: " + name);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const [name, content] of outputs) {
    await fs.writeFile(path.join(outputDir, name), content, { flag: "wx", encoding: "utf8" });
  }
  return { review, packet, template, paths: outputs.map(([name]) => path.join(outputDir, name)) };
}

function cliValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] || null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourcePath = cliValue("--input");
  const outputDir = cliValue("--output-dir");
  const scopePath = cliValue("--scope-json");
  const packetConfigPath = cliValue("--packet-config-json");
  if (process.argv[2] !== "generate" || !sourcePath || !outputDir || !scopePath || !packetConfigPath) {
    console.error("Usage: node scripts/carousell-review.mjs generate --input SOURCE.md --output-dir DIR --scope-json SCOPE.json --packet-config-json PACKET.json");
    process.exitCode = 2;
  } else {
    Promise.all([
      fs.readFile(scopePath, "utf8").then(JSON.parse),
      fs.readFile(packetConfigPath, "utf8").then(JSON.parse)
    ]).then(([scope, packetConfig]) => generateOutputs({ outputDir, sourcePath, scope, packetConfig })).then(result => {
      console.log(JSON.stringify({
        rows: result.review.rows.length,
        pilotIds: result.packet.items.map(item => item.listingId),
        packetContentSha256: result.packet.integrity.packetContentSha256,
        paths: result.paths
      }, null, 2));
    }).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
