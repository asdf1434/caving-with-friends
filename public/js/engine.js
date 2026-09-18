/* ============================================================
   ENGINE

   Pure game rules, ported from trangium's Blackjack Caving.

   Nothing in this file knows about the network, the DOM, or
   other players. Given a variant, a seed and a word list it
   produces the same ten puzzles on every machine, which is
   what lets the server send an integer instead of puzzle data.
   ============================================================ */

"use strict";


/* ============================================================
   SEEDED RANDOM
   ============================================================

   Mulberry32. Small, fast, and deterministic: the same seed
   always yields the same sequence, so every player in a room
   generates identical puzzles.
*/

export function mulberry32(seed) {

    return function () {

        let t = seed += 0x6D8B79F5;

        t = Math.imul(t ^ t >>> 15, t | 1);

        t ^= t + Math.imul(t ^ t >>> 7, t | 61);

        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}


/* ============================================================
   MATCHING RULES

   One per variant. Each answers the question:
   "does this word contain the rack's letters?"
   ============================================================ */

/*
    Subsequence: every letter of the rack appears in the word
    in the same order, gaps allowed.

        matchSubsequence("CAT", "CHART") = true
        matchSubsequence("CAT", "ACT")   = false
*/

function matchSubsequence(rack, word) {

    let j = 0;

    for (let i = 0; i < word.length && j < rack.length; i++) {

        if (word[i] === rack[j]) {
            j++;
        }
    }

    return j === rack.length;
}


/*
    Contiguous: the rack appears as an unbroken run.

        matchContiguous("CAT", "SCATHING") = true
        matchContiguous("CAT", "CHART")    = false
*/

function matchContiguous(rack, word) {

    return word.includes(rack);
}


/*
    Anagram: the word contains the rack's letters in any order,
    counting duplicates.

        matchAnagram("ACT", "CHART") = true
        matchAnagram("AAT", "CHART") = false   (only one A)
*/

function matchAnagram(rack, word) {

    const counts = new Map();

    for (const character of rack) {
        counts.set(character, (counts.get(character) || 0) + 1);
    }

    for (const character of word) {

        if (counts.has(character)) {

            const remaining = counts.get(character) - 1;

            if (remaining === 0) {
                counts.delete(character);
            } else {
                counts.set(character, remaining);
            }
        }
    }

    return counts.size === 0;
}


/* ============================================================
   LETTER BAGS
   ============================================================ */

const UNIFORM_BAG = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/*
    The anagram variant weights its bag towards vowels as the
    rack grows, otherwise long racks almost never produce a
    solvable puzzle.
*/

const ANAGRAM_BAGS = {
    3: UNIFORM_BAG,
    4: "AAABCDDEEEFGHIIJKLLMNNOOPQRRSSTTUVWXYZ",
    5: "AAAAABBCCCDDDDEEEEEEEFFGGHHIIIIIJKLLLLMMNNNNOOOOOPPQRRRRSSSSTTTTUUUVWXYZ"
};


function drawRack(random, length, bag) {

    let result = "";

    for (let i = 0; i < length; i++) {
        result += bag[Math.floor(random() * bag.length)];
    }

    return result;
}


/* ============================================================
   VARIANTS

   Each variant is the original game with a different matching
   rule and a few tuned constants. Collecting them here is what
   removes the copy-paste duplication in the upstream repo.
   ============================================================ */

export const VARIANTS = {

    blackjack: {
        id: "blackjack",
        name: "Blackjack",
        rule: "Letters in order, gaps allowed",
        example: "CVG → CAVING",

        durationSeconds: 120,
        minAnswers: 15,

        match: matchSubsequence,

        makeRack(random) {
            return drawRack(
                random,
                Math.min(4, Math.floor(random() * 3) + 3),
                UNIFORM_BAG
            );
        },

        minWordLength() {
            return 6;
        }
    },

    contiguous: {
        id: "contiguous",
        name: "Contiguous",
        rule: "Letters together, unbroken",
        example: "CAT → SCATHING",

        durationSeconds: 90,
        minAnswers: 10,

        match: matchContiguous,

        makeRack(random) {
            return drawRack(
                random,
                Math.min(4, Math.floor(random() * 3) + 3),
                UNIFORM_BAG
            );
        },

        minWordLength() {
            return 6;
        }
    },

    anagram: {
        id: "anagram",
        name: "Anagram",
        rule: "Letters in any order",
        example: "ACT → CHART",

        durationSeconds: 150,
        minAnswers: 15,

        match: matchAnagram,

        /* The rack is displayed sorted, since order is irrelevant. */
        sortRack: true,

        makeRack(random) {

            const length = Math.floor(random() * 3) + 3;

            return drawRack(random, length, ANAGRAM_BAGS[length]);
        },

        minWordLength(rack) {
            return rack.length === 3 ? 5 : rack.length + 1;
        }
    }
};


export const VARIANT_IDS = Object.keys(VARIANTS);


/* ============================================================
   WORD LISTS
   ============================================================

   common  - CEL22.txt. Puzzle answers come only from here.
   valid   - words_alpha.txt. Anything in here is a real word;
             the ones absent from common become bonus words.
*/

export function prepareWordLists(commonText, validText) {

    const common = [...new Set(
        commonText
            .split(/\r?\n/)
            .map(word => word.trim().toUpperCase())
            .filter(word => /^[A-Z]+$/.test(word))
    )];

    const valid = new Set(
        validText
            .split(/\r?\n/)
            .map(word => word.trim().toUpperCase())
            .filter(word => /^[A-Z]+$/.test(word))
    );

    /*
        Shortest words first.

        Rack generation rejects any rack that has an answer
        below the minimum length, so testing short words first
        lets a bad rack be discarded after a few thousand
        comparisons instead of all 69,000. Same puzzles, an
        order of magnitude less work.
    */

    const byLength = common
        .slice()
        .sort((a, b) =>
            a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
        );

    return {
        common: common,
        commonSet: new Set(common),
        commonByLength: byLength,
        valid: valid
    };
}


/* ============================================================
   ANSWERS
   ============================================================ */

export function answers(variant, rack, wordList) {

    const result = [];

    for (const word of wordList) {

        if (word.length < rack.length) {
            continue;
        }

        if (variant.match(rack, word)) {
            result.push(word);
        }
    }

    return result;
}


/*
    Generation-time version.

    Returns null the moment the rack proves unusable, rather
    than collecting every answer first.
*/

function collectAnswersOrReject(variant, rack, wordsByLength) {

    const minimumLength = variant.minWordLength(rack);

    const result = [];

    for (const word of wordsByLength) {

        if (word.length < rack.length) {
            continue;
        }

        if (!variant.match(rack, word)) {
            continue;
        }

        if (word.length < minimumLength) {
            return null;
        }

        result.push(word);
    }

    return result.length >= variant.minAnswers ? result : null;
}


/* ============================================================
   PUZZLE GENERATION
   ============================================================

   A board, driven entirely by the seed. Two clients with the
   same seed, variant, word list and count produce identical
   puzzles, which is the whole basis of the multiplayer design.
*/

export const DEFAULT_PUZZLE_COUNT = 10;

/*
    What the host can choose. Kept to a short list of round
    numbers: the values in between play the same, and a long
    dropdown is worse to read than a short one.

    The upper end is where the scoreboard stops fitting a phone
    screen, since it draws a column per puzzle.
*/
export const PUZZLE_COUNTS = [5, 10, 15, 20];


export function isPuzzleCount(value) {
    return PUZZLE_COUNTS.includes(value);
}

const MAX_RACK_ATTEMPTS = 200000;


export function generatePuzzles(
    variantId,
    seed,
    wordLists,
    puzzleCount = DEFAULT_PUZZLE_COUNT
) {

    const variant = VARIANTS[variantId];

    if (!variant) {
        throw new Error(`Unknown variant: ${variantId}`);
    }

    const random = mulberry32(seed);

    const puzzles = [];

    /*
        The original allows the same rack to appear twice on one
        board. Harmless in a solo game, confusing in a shared one,
        so duplicates are rejected here.
    */

    const used = new Set();

    let attempts = 0;

    while (puzzles.length < puzzleCount) {

        if (++attempts > MAX_RACK_ATTEMPTS) {
            throw new Error("Could not generate puzzles for this seed");
        }

        let rack = variant.makeRack(random);

        if (variant.sortRack) {
            rack = rack.split("").sort().join("");
        }

        if (used.has(rack)) {
            continue;
        }

        const found = collectAnswersOrReject(
            variant,
            rack,
            wordLists.commonByLength
        );

        if (found === null) {
            continue;
        }

        /* Alphabetical, so the answer list reads sensibly later. */
        found.sort();

        used.add(rack);

        let shortestLength = Infinity;

        for (const word of found) {
            shortestLength = Math.min(shortestLength, word.length);
        }

        puzzles.push({
            rack: rack,
            answers: found,
            answerSet: new Set(found),
            shortestLength: shortestLength
        });
    }

    /*
        Hardest first: fewer answers means a higher base score,
        and the original orders the board the same way.
    */

    puzzles.sort((a, b) => b.answers.length - a.answers.length);

    return puzzles;
}


/* ============================================================
   SCORING
   ============================================================

   A puzzle is worth points for being solved EARLY and for being
   solved BEFORE other people. Which word you used does not
   matter; how quickly and how soon does.

       points = (BASE
                 - RANK_PENALTY * (rank - 1)
                 - TIME_PENALTY * secondsElapsed)
                * rarity multiplier

   floored at MIN_POINTS.

   Two of those terms are room settings:

     difficultyScoring  off, the rarity multiplier is 1 for
                        every puzzle, so a hard rack pays what
                        an easy one pays.

     timeDecay          off, the time penalty is 0, so a puzzle
                        pays the same at the end of the round as
                        at the start. Rank still matters.

   rank is 1 for the first player to solve that puzzle, 2 for
   the next, and so on. secondsElapsed is measured from the
   moment the round started.

   Every number below is meant to be edited. The server sends
   its own copy of these to the clients, so changing them here
   and restarting changes the game for everyone in the room.
   ============================================================ */

export const SCORING = {

    /* What a puzzle is worth to whoever solves it instantly. */
    BASE: 1000,

    /* Taken off for each player who got there before you. */
    RANK_PENALTY: 200,

    /* Taken off per second since the round began. */
    TIME_PENALTY: 2,

    /* No solve is ever worth less than this. */
    MIN_POINTS: 50,

    /*
        How much a puzzle's difficulty matters, from 0 to 1.

        0   every puzzle is worth the same.
        1   a rack with few possible answers is worth several
            times one with hundreds.

        Difficulty is measured as max(1, 8 - log2(answers)),
        which is the original game's rarity term. Dividing by
        RARITY_REFERENCE puts a puzzle with 16 answers at
        exactly 1.0, so that is the puzzle that scores BASE.
    */
    RARITY_WEIGHT: 1,
    RARITY_REFERENCE: 4
};


/*
    How much this puzzle's difficulty scales its award.

    Kept separate so the server, which never loads the word
    lists, can work from an answer count alone.

    Rooms can turn difficulty scaling off, in which case every
    puzzle is scored the same and this returns 1.
*/

export function rarityMultiplier(answerCount, difficultyScoring = true) {

    if (!difficultyScoring) {
        return 1;
    }

    const rarity =
        Math.max(1, 8 - Math.log2(answerCount)) / SCORING.RARITY_REFERENCE;

    return 1 + SCORING.RARITY_WEIGHT * (rarity - 1);
}


/*
    The award and every step that produced it, so a solved card
    can show its working rather than an unexplained number.
*/

export function scoreBreakdown(
    answerCount,
    rank,
    secondsElapsed,
    options = {}
) {

    /*
        Both settings default to on, so a caller that knows
        nothing about them scores the game as shipped.
    */

    const difficultyScoring = options.difficultyScoring !== false;
    const timeDecay = options.timeDecay !== false;

    const elapsed = Math.max(0, secondsElapsed);

    const rankPenalty = SCORING.RANK_PENALTY * (rank - 1);
    const timePenalty = timeDecay ? SCORING.TIME_PENALTY * elapsed : 0;
    const rarity = rarityMultiplier(answerCount, difficultyScoring);

    const subtotal = SCORING.BASE - rankPenalty - timePenalty;

    const total = Math.max(
        SCORING.MIN_POINTS,
        Math.round(subtotal * rarity)
    );

    return {
        base: SCORING.BASE,
        rank: rank,
        rankPenalty: Math.round(rankPenalty),
        elapsed: elapsed,
        timePenalty: Math.round(timePenalty),
        rarity: rarity,
        timeDecay: timeDecay,
        subtotal: Math.round(subtotal),

        /* True when the floor, not the arithmetic, set the award. */
        floored: Math.round(subtotal * rarity) < SCORING.MIN_POINTS,

        total: total
    };
}


export function calculateScore(
    answerCount,
    rank,
    secondsElapsed,
    options = {}
) {

    return scoreBreakdown(
        answerCount,
        rank,
        secondsElapsed,
        options
    ).total;
}


/* ============================================================
   SUBMISSION

   A word counts if it is a real word and it matches the rack.

   The common list (CEL22) is used to choose racks and to
   measure how hard a puzzle is. It does not decide what you
   are allowed to play: anything in words_alpha.txt scores
   normally, so there is no second class of word.

   Results:
     not-a-word  - absent from words_alpha.txt
     no-match    - a real word that fits no rack on the board
     answer      - matches one or more racks
   ============================================================ */

export function classifyWord(variantId, puzzles, wordLists, word) {

    const variant = VARIANTS[variantId];

    if (!wordLists.valid.has(word)) {
        return { kind: "not-a-word" };
    }

    const indexes = [];

    puzzles.forEach((puzzle, index) => {

        if (
            word.length >= puzzle.rack.length &&
            variant.match(puzzle.rack, word)
        ) {
            indexes.push(index);
        }
    });

    return indexes.length > 0
        ? { kind: "answer", indexes: indexes }
        : { kind: "no-match" };
}
