const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const {compareUtf16} = require("../dist/src/common/order.js");

const values = ["z", "a", "ä", "A", "😀", "😃", "𐀀", "￿"];
assert.deepEqual([...values].sort(compareUtf16), [...values].sort());
assert.equal(compareUtf16("same", "same"), 0);
assert.equal(compareUtf16("a", "b"), -1);
assert.equal(compareUtf16("b", "a"), 1);

console.log("UTF-16 ordering tests passed");

const inspectSource = fs.readFileSync(
    path.resolve(__dirname, "../consumers/postgres-migrations/src/inspect-schema.ts"),
    "utf8",
);
assert.equal(inspectSource.includes("function utf16Compare"), false);
assert.equal(inspectSource.includes("sort(compareUtf16)"), true);
