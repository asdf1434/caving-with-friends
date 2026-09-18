/* ============================================================
   ENGINE TESTS

   Two things here would break silently and ruin a game:

     - Puzzle generation drifting between clients, which would
       hand players different boards from the same seed.
     - Scoring drifting from the original formulas.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    VARIANT_IDS,
    VARIANTS,
    DEFAULT_PUZZLE_COUNT,
    PUZZLE_COUNTS,
    SCORING,
    prepareWordLists,
    scoreBreakdown,
    generatePuzzles,
    calculateScore,
    rarityMultiplier,
    classifyWord,
    mulberry32
} from "../public/js/engine.js";


const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "..", "public", "data");

const wordLists = prepareWordLists(
    fs.readFileSync(path.join(DATA, "CEL22.txt"), "utf8"),
    fs.readFileSync(path.join(DATA, "words_alpha.txt"), "utf8")
);


test("mulberry32 is deterministic", () => {

    const first = Array.from({ length: 5 }, mulberry32(42));
    const second = Array.from({ length: 5 }, mulberry32(42));

    assert.deepEqual(first, second);
    assert.notDeepEqual(first, Array.from({ length: 5 }, mulberry32(43)));
});


test("the same seed produces the same board on every client", () => {

    for (const variant of VARIANT_IDS) {

        const first = generatePuzzles(variant, 20260909, wordLists);
        const second = generatePuzzles(variant, 20260909, wordLists);

        assert.deepEqual(
            first.map(puzzle => puzzle.rack),
            second.map(puzzle => puzzle.rack),
            `${variant} racks differ between runs`
        );

        assert.deepEqual(
            first.map(puzzle => puzzle.answers.length),
            second.map(puzzle => puzzle.answers.length)
        );
    }
});


test("different seeds produce different boards", () => {

    const a = generatePuzzles("blackjack", 1, wordLists);
    const b = generatePuzzles("blackjack", 2, wordLists);

    assert.notDeepEqual(
        a.map(puzzle => puzzle.rack),
        b.map(puzzle => puzzle.rack)
    );
});


test("boards obey each variant's constraints", () => {

    for (const variantId of VARIANT_IDS) {

        const variant = VARIANTS[variantId];
        const puzzles = generatePuzzles(variantId, 777, wordLists);

        assert.equal(puzzles.length, DEFAULT_PUZZLE_COUNT);

        const racks = new Set(puzzles.map(puzzle => puzzle.rack));

        assert.equal(
            racks.size,
            DEFAULT_PUZZLE_COUNT,
            `${variantId} repeated a rack`
        );

        for (const puzzle of puzzles) {

            assert.ok(
                puzzle.answers.length >= variant.minAnswers,
                `${variantId} ${puzzle.rack} has too few answers`
            );

            const minimum = variant.minWordLength(puzzle.rack);

            for (const answer of puzzle.answers) {

                assert.ok(
                    answer.length >= minimum,
                    `${variantId} ${puzzle.rack} allows ${answer}`
                );

                assert.ok(
                    variant.match(puzzle.rack, answer),
                    `${variantId} ${puzzle.rack} does not match ${answer}`
                );
            }
        }

        /* Hardest first, as upstream orders the board. */
        const counts = puzzles.map(puzzle => puzzle.answers.length);

        assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
    }
});


test("matching rules behave as the original does", () => {

    assert.ok(VARIANTS.blackjack.match("CAT", "CHART"));
    assert.ok(!VARIANTS.blackjack.match("CAT", "ACT"));

    assert.ok(VARIANTS.contiguous.match("CAT", "SCATHING"));
    assert.ok(!VARIANTS.contiguous.match("CAT", "CHART"));

    assert.ok(VARIANTS.anagram.match("ACT", "CHART"));
    assert.ok(!VARIANTS.anagram.match("AAT", "CHART"));
});


test("scoring falls with rank and with time", () => {

    /*
        A puzzle with 16 answers sits at the rarity reference,
        so it scores BASE exactly when solved instantly.
    */

    assert.equal(calculateScore(16, 1, 0), SCORING.BASE);

    /* Each place down costs RANK_PENALTY. */
    assert.equal(
        calculateScore(16, 1, 0) - calculateScore(16, 2, 0),
        SCORING.RANK_PENALTY
    );

    /* Each second costs TIME_PENALTY. */
    assert.equal(
        calculateScore(16, 1, 0) - calculateScore(16, 1, 10),
        SCORING.TIME_PENALTY * 10
    );

    /* The worked examples from the design. */
    assert.equal(calculateScore(16, 1, 20), 960);
    assert.equal(calculateScore(16, 2, 25), 750);
    assert.equal(calculateScore(16, 3, 45), 510);
    assert.equal(calculateScore(16, 1, 90), 820);
});


test("difficulty scoring can be turned off per room", () => {

    const off = { difficultyScoring: false };
    const on = { difficultyScoring: true };

    /* Off, a rack with 900 answers pays what one with 16 pays. */
    assert.equal(rarityMultiplier(900, false), 1);

    assert.equal(
        calculateScore(900, 1, 10, off),
        calculateScore(16, 1, 10, off)
    );

    /* On is the default and still favours the rarer rack. */
    assert.equal(calculateScore(16, 1, 10, on), calculateScore(16, 1, 10));
    assert.ok(calculateScore(16, 1, 10, on) > calculateScore(900, 1, 10, on));
});


test("time decay can be turned off per room", () => {

    const off = { timeDecay: false };

    /* Off, the clock stops changing what a solve is worth. */
    assert.equal(
        calculateScore(16, 1, 90, off),
        calculateScore(16, 1, 0, off)
    );

    /* On, which is the default, it still falls with time. */
    assert.ok(calculateScore(16, 1, 0) > calculateScore(16, 1, 90));

    /* Rank is untouched by either setting. */
    assert.ok(calculateScore(16, 1, 30, off) > calculateScore(16, 2, 30, off));

    const breakdown = scoreBreakdown(16, 1, 90, off);

    assert.equal(breakdown.timePenalty, 0);
    assert.equal(breakdown.timeDecay, false);

    /* Both off leaves the base, less whatever rank costs. */
    assert.equal(
        calculateScore(900, 1, 120, { timeDecay: false, difficultyScoring: false }),
        SCORING.BASE
    );
});


test("no solve is ever worth less than the floor", () => {

    assert.equal(calculateScore(16, 20, 3000), SCORING.MIN_POINTS);
    assert.ok(calculateScore(900, 9, 600) >= SCORING.MIN_POINTS);
});


test("rarer puzzles are worth more", () => {

    /* Fewer answers, more points, at the same rank and time. */
    assert.ok(calculateScore(16, 1, 10) > calculateScore(900, 1, 10));
    assert.ok(calculateScore(20, 1, 10) > calculateScore(200, 1, 10));

    /* The reference puzzle is the one that neither gains nor loses. */
    assert.equal(rarityMultiplier(16), 1);

    /* Turning the weight off makes every puzzle worth the same. */
    const weight = SCORING.RARITY_WEIGHT;

    try {
        SCORING.RARITY_WEIGHT = 0;

        assert.equal(rarityMultiplier(900), 1);
        assert.equal(calculateScore(900, 1, 10), calculateScore(16, 1, 10));

    } finally {
        SCORING.RARITY_WEIGHT = weight;
    }
});


test("scoring shows its working", () => {

    const points = scoreBreakdown(16, 2, 25);

    assert.equal(points.base, SCORING.BASE);
    assert.equal(points.rankPenalty, SCORING.RANK_PENALTY);
    assert.equal(points.timePenalty, SCORING.TIME_PENALTY * 25);
    assert.equal(points.rarity, 1);
    assert.equal(points.subtotal, 750);
    assert.equal(points.floored, false);

    /* The parts add up to the number shown on the card. */
    assert.equal(
        Math.round(
            (points.base - points.rankPenalty - points.timePenalty) *
            points.rarity
        ),
        points.total
    );

    /* A hopeless solve is flagged as having hit the floor. */
    const late = scoreBreakdown(900, 5, 200);

    assert.equal(late.total, SCORING.MIN_POINTS);
    assert.equal(late.floored, true);
});


test("any real word that matches a rack is an answer", () => {

    const puzzles = generatePuzzles("blackjack", 12345, wordLists);

    const classify = word =>
        classifyWord("blackjack", puzzles, wordLists, word).kind;

    assert.equal(classify("QQQQQQ"), "not-a-word");

    /* A common word that answers one of these racks. */
    assert.equal(classify(puzzles[0].answers[0]), "answer");

    /* A real word that matches nothing on this board. */
    assert.equal(classify("THE"), "no-match");

    /*
        A word absent from the common list used to be a
        zero-point "bonus word". It is now an ordinary answer,
        so anything real that matches a rack scores.
    */

    const rack = puzzles[0].rack;

    const rare = [...wordLists.valid].find(word =>
        !wordLists.commonSet.has(word) &&
        word.length >= rack.length &&
        VARIANTS.blackjack.match(rack, word)
    );

    assert.ok(rare, "no rare word matched the first rack");
    assert.equal(classify(rare), "answer");

    /* And the puzzle it answers is the one it matched. */
    const result = classifyWord("blackjack", puzzles, wordLists, rare);

    assert.ok(result.indexes.includes(0));
});


test("a board can be asked for any of the offered sizes", () => {

    for (const count of PUZZLE_COUNTS) {

        const puzzles = generatePuzzles("blackjack", 4242, wordLists, count);

        assert.equal(puzzles.length, count);

        const racks = new Set(puzzles.map(puzzle => puzzle.rack));

        assert.equal(racks.size, count, `${count} repeated a rack`);
    }
});
