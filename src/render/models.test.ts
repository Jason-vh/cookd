import { describe, expect, test } from "bun:test";
import { INGREDIENTS } from "../data/ingredients";
import { modelledBases } from "./models";

/**
 * Every ingredient needs a model.
 *
 * A missing one is not a crash — `fallback` draws a grey rounded box and the
 * game carries on. That is the worst kind of content failure, because it looks
 * deliberate. `validateContent` cannot check this: `data/` must not import
 * `render/`, so the coverage has to be asserted from this side.
 */
describe("every ingredient is drawn", () => {
  test("has a base model", () => {
    const missing = Object.keys(INGREDIENTS).filter((id) => !modelledBases().includes(id));
    expect(missing).toEqual([]);
  });

  test("and no model is left over from an ingredient that is gone", () => {
    const orphaned = modelledBases().filter((id) => !Object.hasOwn(INGREDIENTS, id));
    expect(orphaned).toEqual([]);
  });
});
