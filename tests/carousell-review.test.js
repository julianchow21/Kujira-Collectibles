import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildCanonicalReview,
  buildPilotPacket,
  assertCanonicalReview,
  assertPilotPacket,
  canonicalCarousellUrl,
  computeSuggestedPrice,
  digestJson,
  parseMoneyCell,
  parseReviewMarkdown,
  receiptTemplate,
  roundAllowedEnding,
  validateExecutorReceipts,
  TARGET_CONTROLS,
  MEETUP_NOTE,
  MEETUP_VENUE,
  CANDIDATE_CONFIG,
  FROZEN_PACKET_CONFIG
} from "../scripts/carousell-review.mjs";

function clone(value) {
  return structuredClone(value);
}

const SYNTHETIC_SOURCE_PATH = fileURLToPath(new URL("./Review Fixture.md", import.meta.url));
const FROZEN_PACKET_PATH = process.env.CAROUSELL_FROZEN_PACKET || null;
const SYNTHETIC_CONFIG = {
  sourcePath: SYNTHETIC_SOURCE_PATH,
  scope: {
    historicalRows: 5,
    historicalLiveRows: 5,
    historicalPendingRows: 0,
    currentPublicProfileCountObserved: 5,
    requestedScopeCount: 5,
    requestedListingIds: null,
    snapshotDate: "12/09/2026 00:00:00 SGT",
    pricingRule: CANDIDATE_CONFIG.scope.pricingRule,
    currentSourceLedger: { sourceRows: 5, posted: 5, excludedSold: 0, removed: 0, unavailable: 0, note: "Synthetic fixture" },
    supersededSourceLedger: { posted: 5, partial: 0, hold: 0, removed: 0, note: "Synthetic fixture" }
  },
  pilotIds: CANDIDATE_CONFIG.pilotIds,
  pilotFacts: CANDIDATE_CONFIG.pilotFacts
};

function buildReview() {
  return buildCanonicalReview({ sourcePath: SYNTHETIC_CONFIG.sourcePath, scope: SYNTHETIC_CONFIG.scope });
}

function buildPacket(review) {
  return buildPilotPacket(review, SYNTHETIC_CONFIG);
}

function validate(packet, document) {
  return validateExecutorReceipts(packet, document, SYNTHETIC_CONFIG);
}

function validReceipt(item) {
  const beforeControls = {
    fixedPriceOn: true,
    preOrderOn: false,
    meetupOn: true,
    officialDeliveryOn: true,
    buyButtonOn: true,
    buyerProtectionOn: true
  };
  const evidence = suffix => ({
    observed: true,
    identityUrl: item.identityUrl,
    card: item.card,
    grade: item.grade,
    certificate: item.certificate,
    priceSgd: suffix === "before" ? item.before.priceSgd : item.after.priceSgd,
    description: suffix === "before" ? item.before.description : item.after.description,
    controls: suffix === "before" ? beforeControls : clone(TARGET_CONTROLS),
    evidenceRef: "synthetic-test://" + item.listingId + "/" + suffix
  });
  const receipt = {
    listingId: item.listingId,
    packetItemSha256: item.integrity.itemSha256,
    before: {
      ...evidence("before"),
      freshBeforeEvidenceRef: "synthetic-test://" + item.listingId + "/fresh-before",
      photoCertificateComparison: "VERIFIED"
    },
    save: {
      attempted: true,
      outcome: "SAVED",
      evidenceRef: "synthetic-test://" + item.listingId + "/save"
    },
    reopen: {
      ...evidence("after"),
      valuesMatch: true
    },
    public: evidence("after"),
    after: {
      ...evidence("after"),
      meetupVenue: MEETUP_VENUE,
      meetupNote: MEETUP_NOTE
    }
  };
  const body = clone(receipt);
  body.integrity = {};
  receipt.integrity = { receiptSha256: digestJson(body) };
  return receipt;
}

function syntheticStructuralFixture(packet) {
  return {
    schemaVersion: 1,
    kind: "CAROUSELL_EXECUTOR_RECEIPT",
    status: "STRUCTURAL_VALIDATION_ONLY",
    packetContentSha256: packet.integrity.packetContentSha256,
    receipts: packet.items.map(validReceipt)
  };
}

test("parser keeps NBSP blanks and distinct copies", () => {
  const fixture = [
    "## Live listings (2 rows)",
    "| Card | Converted PC S$ | Suggested S$ | Decided Carousell price | PriceCharting | Carousell | Cert |",
    "|:---|---:|---:|---:|:---|:---|:---|",
    "| Bulbasaur TAG 9 | S$12.00 |  |   | [PriceCharting](https://example.test/pc/one) | [Carousell](https://www.carousell.sg/p/bulbasaur-one-100000001/?source=test) | P1 |",
    "| Bulbasaur TAG 9 |  |  | 35 |  | [Carousell](https://www.carousell.sg/p/bulbasaur-two-100000002/) | R2 |"
  ].join("\n");
  const rows = parseReviewMarkdown(fixture);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].decidedPriceSgd, null);
  assert.equal(rows[0].convertedPcSgd, 12);
  assert.equal(rows[0].listingUrl, "https://www.carousell.sg/p/bulbasaur-one-100000001/");
  assert.equal(rows[1].decidedPriceSgd, 35);
  assert.notEqual(rows[0].listingId, rows[1].listingId);
  assert.equal(canonicalCarousellUrl(rows[0].listingUrl + "?bad=1", rows[0].listingId), rows[0].listingUrl);
});

test("money parser rejects permissive or non-finite values", () => {
  assert.equal(parseMoneyCell("\u00a0"), null);
  assert.equal(parseMoneyCell(""), null);
  assert.equal(parseMoneyCell("S$1.25"), 1.25);
  assert.throws(() => parseMoneyCell("US$10"), /Invalid money/);
  assert.throws(() => parseMoneyCell("$1oops"), /Invalid money/);
  assert.throws(() => parseMoneyCell("Infinity"), /Invalid money/);
  assert.throws(() => parseMoneyCell("-1"), /Invalid money/);
});

test("price rule uses exact ending rounding and requires dated FX provenance", () => {
  const examples = [
    ["132", 132], ["132.01", 135], ["138.01", 140], ["140.01", 142],
    ["131.76", 132], ["134", 135], ["136", 138], ["139", 140],
    ["73.90", 75], ["40.33", 42]
  ];
  examples.forEach(([input, expected]) => assert.equal(roundAllowedEnding(input), expected));
  const result = computeSuggestedPrice("40.33", "1", {
    rateDate: "07/09/2026",
    rateSource: "synthetic MAS FX fixture"
  });
  assert.equal(result.priceSgd, 55);
  assert.equal(result.rateDate, "07/09/2026");
  assert.equal(result.calculationOnly, true);
  assert.equal(result.liveFxVerified, false);
  assert.equal(result.notApproved, true);
  assert.throws(() => computeSuggestedPrice("40.33", "1", {}), /rate date/);
  assert.throws(() => computeSuggestedPrice("40.33", "1", { rateDate: "07/09/2026" }), /rate source/);
  assert.throws(() => computeSuggestedPrice("0", "1", { rateDate: "07/09/2026", rateSource: "x" }), /USD amount/);
  assert.throws(() => computeSuggestedPrice("1", "0", { rateDate: "07/09/2026", rateSource: "x" }), /FX rate/);
  assert.throws(() => computeSuggestedPrice("1", "1", { rateDate: "31/02/2026", rateSource: "x" }), /real date/);
  assert.throws(() => computeSuggestedPrice("1", "1", { rateDate: "07/09/2026", rateSource: "   " }), /rate source/);
});

test("configured historical source builds a canonical review and pilot packet", async () => {
  const review = await buildReview();
  assertCanonicalReview(review, SYNTHETIC_CONFIG.scope);
  assert.equal(review.rows.length, 5);
  assert.equal(new Set(review.rows.map(row => row.listingId)).size, 5);
  const packet = buildPacket(review);
  assertPilotPacket(packet, SYNTHETIC_CONFIG);
  assert.deepEqual(packet.items.map(item => item.listingId), CANDIDATE_CONFIG.pilotIds);
  assert.deepEqual(packet.items.map(item => item.after.priceSgd), [200, 296, 150, 155, 155]);
  assert.equal(packet.sourceScope.currentPublicProfileCountObserved, 5);
  assert.equal(packet.sourceScope.requestedListingIds, null);
  const expectedBefore = {
    "1459807033": "Alakazam ex 203/165, Japanese Scarlet & Violet 151, 2023. Special Art Rare Holo.\n\nTAG 10 Gem Mint, certificate Z7583128. The photos show the actual slab, front and back. Please review the photos for the slab and protective sleeve condition.\n\nFixed price: S$420.\nMeet-up: 34 Cassia Crescent, Singapore 390034, Block 34.",
    "1459986557": "Meetups at S390034. Tracked mail +$3. PSA 9 Cert number: 100703714.\n\nPokemon Arceus VSTAR GG70/GG70 Crown Zenith English Secret Rare.\n\n#psa #tag #pokemon #arceus #crownzenith #gg70",
    "1459786398": "Meetups at S390034. Tracked mail +$3. TAG 10 Cert number: Y8343649.\n\nPokemon Arceus V 267/S-P Japanese Pokémon Legends: Arceus Pre-Order Promo.\n\n#psa #tag #pokemon #arceus #pokemonlegendsarceus #promo",
    "1459797036": "Bulbasaur 143/142, English Stellar Crown, 2024. Illustration Rare Holo.\n\nTAG 9 Mint, certificate P6884835. The photos show the actual slab, front and back. Please review the photos for the slab and protective sleeve condition.\n\nFixed price: S$210.\nMeet-up: 34 Cassia Crescent, Singapore 390034, Block 34.",
    "1459797377": "Bulbasaur 143/142, English Stellar Crown, 2024. Illustration Rare Holo.\n\nTAG 9 Mint, certificate R2796848. The photos show the actual slab, front and back. Please review the photos for the slab and protective sleeve condition.\n\nFixed price: S$210.\nMeet-up: 34 Cassia Crescent, Singapore 390034, Block 34."
  };
  packet.items.forEach(item => assert.equal(item.before.description, expectedBefore[item.listingId]));
  packet.items.forEach(item => {
    const paragraphs = item.after.description.split("\n\n");
    assert.equal(paragraphs.length, 3);
    assert.match(paragraphs[0], /Meetups at S390034\. Tracked mail \+\$3\./);
    assert.match(paragraphs[2], /#psa #tag #pokemon/);
    assert.doesNotMatch(item.after.description, /Fixed price/i);
  });
});

test("frozen proposed packet validates with its explicit legacy configuration when supplied", { skip: !FROZEN_PACKET_PATH }, async () => {
  const packet = JSON.parse(await fs.readFile(FROZEN_PACKET_PATH, "utf8"));
  assertPilotPacket(packet, FROZEN_PACKET_CONFIG);
  assert.equal(packet.integrity.packetContentSha256, "fb15206e8542702045899f2cd24d7f35062ca2e3a17e4afebb4d5e3a7cf7971a");
  const template = receiptTemplate(packet, FROZEN_PACKET_CONFIG);
  assert.equal(template.status, "EMPTY_TEMPLATE");
  assert.equal(validateExecutorReceipts(packet, template, FROZEN_PACKET_CONFIG).ok, false);
});

test("historical source integration is optional outside the canonical repository", { skip: !process.env.CAROUSELL_REVIEW_SOURCE }, async () => {
  const sourcePath = process.env.CAROUSELL_REVIEW_SOURCE;
  const review = await buildCanonicalReview({ sourcePath, scope: CANDIDATE_CONFIG.scope });
  assertCanonicalReview(review, CANDIDATE_CONFIG.scope);
});

test("packet mutation and duplicate receipt membership fail closed", async () => {
  const packet = buildPacket(await buildReview());
  const changed = clone(packet);
  changed.items[0].after.priceSgd = 201;
  assert.throws(() => assertPilotPacket(changed, SYNTHETIC_CONFIG), /price mismatch|item digest mismatch|packet content digest mismatch/);
  const document = syntheticStructuralFixture(packet);
  document.receipts[4].listingId = document.receipts[0].listingId;
  const result = validate(packet, document);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /missing or duplicate|duplicate/);
  assert.equal(validate(null, document).ok, false);
  const nullRows = { ...document, receipts: [null, null, null, null, null] };
  assert.equal(validate(null, nullRows).ok, false);
});

test("synthetic valid-shaped fixture passes structural checks but never live completion", async () => {
  const packet = buildPacket(await buildReview());
  const fixture = syntheticStructuralFixture(packet);
  const structural = validate(packet, fixture);
  assert.equal(structural.ok, true);
  assert.equal(structural.status, "STRUCTURAL_VALIDATION_ONLY");
  assert.equal(structural.completion, false);
  const markedSynthetic = clone(fixture);
  markedSynthetic.fixtureLabel = "SYNTHETIC";
  assert.equal(validate(packet, markedSynthetic).ok, false);
  const live = JSON.parse(JSON.stringify(fixture).replaceAll("synthetic-test://", "evidence://observed/"));
  live.status = "LIVE_VERIFIED";
  live.approvalReference = "evidence://approval/invented";
  live.approvalPacketContentSha256 = packet.integrity.packetContentSha256;
  live.photoCertificateComparison = {
    status: "VERIFIED",
    packetContentSha256: packet.integrity.packetContentSha256,
    evidenceRef: "evidence://photos/compare"
  };
  live.receipts.forEach(receipt => {
    const body = clone(receipt);
    body.integrity = {};
    receipt.integrity = { receiptSha256: digestJson(body) };
  });
  const liveShape = validate(packet, live);
  assert.equal(liveShape.ok, true, liveShape.errors.join(" | "));
  assert.equal(liveShape.status, "LIVE_EVIDENCE_STRUCTURE");
  assert.equal(liveShape.completion, false);
  assert.equal(liveShape.requiresIndependentReview, true);
  const invented = clone(fixture);
  invented.status = "LIVE_VERIFIED";
  invented.approvalReference = "invented approval";
  invented.approvalPacketContentSha256 = packet.integrity.packetContentSha256;
  invented.photoCertificateComparison = {
    status: "VERIFIED",
    packetContentSha256: packet.integrity.packetContentSha256,
    evidenceRef: "synthetic-test://invented-photo"
  };
  const inventedResult = validate(packet, invented);
  assert.equal(inventedResult.ok, false);
  assert.equal(inventedResult.completion, false);
  assert.match(inventedResult.errors.join(" "), /synthetic evidence/);
});

test("strict receipt controls and copy checks reject wrong values", async () => {
  const packet = buildPacket(await buildReview());
  const fixture = syntheticStructuralFixture(packet);
  fixture.receipts[0].public.controls.buyButtonOn = "false";
  const result = validate(packet, fixture);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /must be boolean|receipt digest mismatch/);
  const wrongUrl = syntheticStructuralFixture(packet);
  wrongUrl.receipts[0].public.identityUrl = "https://www.carousell.sg/p/other-1459807034/";
  const wrongUrlResult = validate(packet, wrongUrl);
  assert.equal(wrongUrlResult.ok, false);
  assert.match(wrongUrlResult.errors.join(" "), /identity URL mismatch/);
});
