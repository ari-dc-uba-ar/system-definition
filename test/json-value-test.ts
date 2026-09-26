import * as assert from "assert";
import {canonicalJson, toJsonValue} from "../src/common/json-value";

function assertInvalid(value: unknown): void {
    const result = toJsonValue(value);
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.ok(result.problems.length > 0);
        assert.ok(result.problems.some(one => one.severity === 'blocking'));
    }
}

describe("strict JSON values", function () {
    it("validates and copies JSON without mutating or aliasing the source", function () {
        const nested = {value: 1};
        const source = {empty: "", nil: null, nested, list: [nested]};
        const result = toJsonValue(source);
        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.deepEqual(result.value, {
            empty: "",
            nil: null,
            nested: {value: 1},
            list: [{value: 1}],
        });
        nested.value = 2;
        assert.deepEqual(result.value, {
            empty: "",
            nil: null,
            nested: {value: 1},
            list: [{value: 1}],
        });
    });

    it("accepts shared acyclic references", function () {
        const shared = {value: "same"};
        const result = toJsonValue({left: shared, right: shared});
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(result.value, {left: {value: "same"}, right: {value: "same"}});
    });

    it("rejects values JSON serialization would lose or change", function () {
        assertInvalid(undefined);
        assertInvalid(1n);
        assertInvalid(Symbol("x"));
        assertInvalid(function nope() {});
        assertInvalid(Number.NaN);
        assertInvalid(Number.POSITIVE_INFINITY);
        assertInvalid(Number.NEGATIVE_INFINITY);
        assertInvalid({missing: undefined});
        assertInvalid([undefined]);

        const sparse: unknown[] = [];
        sparse.length = 1;
        assertInvalid(sparse);
    });

    it("rejects class instances and cycles", function () {
        class Box {
            value = 1;
        }
        assertInvalid(new Box());

        const cycle: {self?: unknown} = {};
        cycle.self = cycle;
        assertInvalid(cycle);
    });

    it("inspects descriptors without invoking getters, setters, or toJSON", function () {
        let getterCalls = 0;
        let toJsonCalls = 0;
        const withGetter: Record<string, unknown> = {};
        Object.defineProperty(withGetter, "danger", {
            enumerable: true,
            get() {
                getterCalls++;
                throw new Error("getter executed");
            },
        });
        assertInvalid(withGetter);
        assert.equal(getterCalls, 0);

        const withSetter: Record<string, unknown> = {};
        Object.defineProperty(withSetter, "danger", {
            enumerable: true,
            set(_value: unknown) {
                throw new Error("setter executed");
            },
        });
        assertInvalid(withSetter);

        const withToJson = {
            value: 1,
            toJSON() {
                toJsonCalls++;
                return {value: 2};
            },
        };
        assertInvalid(withToJson);
        assert.equal(toJsonCalls, 0);
    });

    it("copies __proto__ as data without changing the result prototype", function () {
        const source = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(source, "__proto__", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: {polluted: true},
        });
        source.normal = 1;

        const result = toJsonValue(source);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(Object.getPrototypeOf(result.value), null);
        assert.deepEqual(Object.getOwnPropertyDescriptor(result.value, "__proto__")?.value, {polluted: true});
        assert.equal(({} as {polluted?: boolean}).polluted, undefined);
    });
});

describe("canonical JSON", function () {
    it("sorts object keys lexicographically by UTF-16, including numeric-looking keys", function () {
        const input = Object.create(null) as {[key: string]: unknown};
        input["2"] = "two";
        input["10"] = "ten";
        input["a"] = "a";
        input["A"] = "A";

        const result = toJsonValue(input);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(canonicalJson(result.value), '{"10":"ten","2":"two","A":"A","a":"a"}');
    });

    it("preserves array order and distinguishes null from the empty string", function () {
        const result = toJsonValue([null, "", -0, 1]);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(canonicalJson(result.value), '[null,"",0,1]');
    });

    it("does not normalize Unicode strings", function () {
        const composed = "é";
        const decomposed = "e\u0301";
        assert.notEqual(composed, decomposed);

        const result = toJsonValue({composed, decomposed});
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(canonicalJson(result.value), JSON.stringify({composed, decomposed}));
    });

    it("throws TypeError for an invalid value supplied through an external cast", function () {
        const invalid = {value: Number.NaN} as unknown as import("../src/common/json-value").JsonValue;
        assert.throws(() => canonicalJson(invalid), TypeError);
    });

    it("does not invoke a getter when rejecting a cast external object", function () {
        let calls = 0;
        const invalid = {} as Record<string, unknown>;
        Object.defineProperty(invalid, "danger", {
            enumerable: true,
            get() {
                calls++;
                throw new Error("getter executed");
            },
        });
        assert.throws(
            () => canonicalJson(invalid as unknown as import("../src/common/json-value").JsonValue),
            TypeError,
        );
        assert.equal(calls, 0);
    });
});
