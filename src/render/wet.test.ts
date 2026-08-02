import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { PAVED, Wet } from "./wet";
import type { Soak } from "../data/biomes";

/**
 * What the rain does to the ground it lands on.
 *
 * The failure this is written against is not "it looks wrong": it is a surface
 * that never dries out, or a lawn that ends up glossier than the paving beside
 * it. Neither throws, both survive review, and both are the whole feature being
 * wrong — the reason wet ground sat unbuilt for so long is precisely that one
 * dial for four surfaces gives you a shiny meadow.
 */

const GRASS: Soak = { darken: 0.16, gloss: 0.1 };

/** A dry material, and the numbers to measure it against later. */
function slab(color = 0x808080, roughness = 0.9): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness });
}

/** Enough frames of `dt` for an eased value to have arrived. */
function soak(wet: Wet, amount: number, seconds = 60): void {
  for (let i = 0; i < seconds * 30; i++) wet.update(amount, 1 / 30);
}

describe("a surface in the rain", () => {
  test("stays exactly as it was on a dry day", () => {
    const wet = new Wet();
    const material = wet.claim(slab(), PAVED);
    soak(wet, 0);

    expect(material.roughness).toBe(0.9);
    expect(material.color.getHex()).toBe(slab().color.getHex());
  });

  test("darkens and loses its roughness once it is soaked", () => {
    const wet = new Wet();
    const material = wet.claim(slab(), PAVED);
    const dry = material.color.clone();
    soak(wet, 1);

    expect(material.roughness).toBeCloseTo(0.9 * (1 - PAVED.gloss), 2);
    expect(material.color.r).toBeCloseTo(dry.r * (1 - PAVED.darken), 2);
    // Darker, not tinted: water takes light away, it does not paint the ground
    // blue. A shift in hue here would be the one thing the grade cannot undo.
    expect(material.color.r / material.color.b).toBeCloseTo(dry.r / dry.b, 5);
  });

  test("dries out again when the day does", () => {
    const wet = new Wet();
    const material = wet.claim(slab(), PAVED);
    soak(wet, 1);
    soak(wet, 0);

    // Exactly, not nearly: an ease never arrives, so it settles onto the number
    // it was heading for. Otherwise every kitchen that had ever seen rain would
    // carry a wetness of 0.0006 for the rest of the week.
    expect(material.roughness).toBe(0.9);
  });
});

describe("only some ground shines", () => {
  test("paving gleams and grass does not", () => {
    const wet = new Wet();
    const paving = wet.claim(slab(), PAVED);
    const grass = wet.claim(slab(), GRASS);
    soak(wet, 1);

    // The whole reason `Soak` is a pair of numbers per surface rather than one
    // dial for the world.
    expect(paving.roughness).toBeLessThan(grass.roughness);
  });

  test("a drizzle wets less than a downpour", () => {
    const light = new Wet();
    const damp = light.claim(slab(), PAVED);
    soak(light, 0.3);

    const heavy = new Wet();
    const soaked = heavy.claim(slab(), PAVED);
    soak(heavy, 1);

    expect(damp.roughness).toBeGreaterThan(soaked.roughness);
    expect(damp.roughness).toBeLessThan(0.9);
  });
});

describe("the change is eased", () => {
  test("rain does not land on one frame", () => {
    const wet = new Wet();
    const material = wet.claim(slab(), PAVED);
    wet.update(1, 1 / 30);

    // Some of the way, nowhere near all of it: a downpour that arrived between
    // two frames would read as a glitch, exactly as a hard cut in the sky does.
    expect(material.roughness).toBeLessThan(0.9);
    expect(material.roughness).toBeGreaterThan(0.9 * (1 - PAVED.gloss) + 0.1);
  });

  test("the ground dries more slowly than it soaks", () => {
    const wetting = new Wet();
    const rising = wetting.claim(slab(), PAVED);
    for (let i = 0; i < 30; i++) wetting.update(1, 1 / 30);

    const drying = new Wet();
    const falling = drying.claim(slab(), PAVED);
    soak(drying, 1);
    for (let i = 0; i < 30; i++) drying.update(0, 1 / 30);

    // One second in each direction. Rain stops at a day boundary, and paving
    // that was dry the moment it did would say the last day never happened.
    expect(0.9 - rising.roughness).toBeGreaterThan(falling.roughness - rising.roughness);
  });
});

describe("a kitchen swap", () => {
  test("forgets the old ground and wets the new", () => {
    const wet = new Wet();
    const old = wet.claim(slab(), PAVED);
    soak(wet, 1);

    wet.clear();
    const fresh = wet.claim(slab(), PAVED);
    const stale = old.roughness;
    wet.update(1, 1 / 30);

    // The old materials go with the meshes they were baked into, so writing to
    // them after a swap is writing to something nobody can see.
    expect(old.roughness).toBe(stale);
    // And the new ground is wet immediately: it is the same rain, over a
    // different restaurant.
    expect(fresh.roughness).toBeCloseTo(stale, 2);
  });
});

describe("a wet mesh", () => {
  test("has a material of its own, shared only with its own colour", () => {
    const wet = new Wet();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const one = wet.mesh(geometry, 0x808080, "stone", PAVED);
    const two = wet.mesh(geometry, 0x808080, "stone", PAVED);
    const other = wet.mesh(geometry, 0x404040, "stone", PAVED);

    // One copy per colour and finish: any more and the merge stops batching
    // the paving into a single draw call.
    expect(two.material).toBe(one.material);
    expect(other.material).not.toBe(one.material);
  });
});
