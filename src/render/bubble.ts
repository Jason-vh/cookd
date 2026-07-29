import * as THREE from "three";
import { RECIPE_BY_ID } from "../data/recipes";
import type { Customer, Item } from "../sim/types";
import { Dial } from "./dial";
import { LAYER, setLayer } from "./layers";
import { buildItemModel } from "./models";
import { PALETTE } from "./palette";

/**
 * The order, floating over the table that placed it.
 *
 * This replaces the HUD ticket list, and it is a straight upgrade: a ticket
 * could tell you *what* and *how long*, while the bubble tells you what, how
 * long, **who** and **how far you have to walk** — the last two being most of
 * what you actually decide with during a rush.
 *
 * It is assembled from parts that already existed: the dish is the same model
 * that would sit on a plate, and the patience ring is the same `Dial` that
 * counts down a fryer. Nothing here is a drawing of a thing; it is the thing.
 */

/**
 * High enough to clear the head of whoever is sitting under it. The bubble has
 * to be readable *without* looking at the table, which is the whole reason it
 * replaced a list in the corner of the screen.
 */
const HEIGHT = 1.85;

export class Bubble {
  readonly object = new THREE.Group();
  private readonly dial: Dial;
  private readonly dish = new THREE.Group();
  private dishKey = "";
  private alpha = 0;
  private pop = 0;

  constructor(camera: THREE.Camera) {
    this.dial = new Dial(camera, 0.56);
    this.object.add(this.dial.object, this.dish);
    this.object.position.y = HEIGHT;
    this.object.visible = false;
    setLayer(this.dish, LAYER.UI);
  }

  /**
   * Show what this customer is waiting for, or fade out when there is nobody
   * to wait for. `dt` drives the ease, so the bubble never pops into being.
   */
  update(customer: Customer | null, dt: number): void {
    const wanted = customer?.state === "ordering" ? customer : null;
    // In fast, out slow: a new order should register instantly, a satisfied one
    // should not snatch itself away the moment the plate lands.
    const rate = wanted ? 10 : 4;
    this.alpha += ((wanted ? 1 : 0) - this.alpha) * Math.min(1, rate * dt);
    this.object.visible = this.alpha > 0.004;
    if (!this.object.visible) return;

    if (wanted) this.setDish(wanted.recipeId);
    this.pop = Math.max(0, this.pop - dt * 3);

    const ratio = wanted ? Math.max(0, wanted.remaining / wanted.patience) : 0;
    // Urgency is carried by movement as well as colour: in peripheral vision,
    // across a room full of tables, a pulse is what gets looked at.
    const urgent = ratio < 0.25;
    const pulse = urgent ? 1 + Math.sin(performance.now() * 0.012) * 0.07 : 1;
    this.dial.apply({
      progress: ratio,
      color:
        ratio > 0.5
          ? PALETTE.progressGood
          : ratio > 0.25
            ? PALETTE.progressCook
            : PALETTE.progressBurn,
      alpha: this.alpha,
      flash: this.pop,
      scale: pulse * this.alpha * (1 + this.pop * 0.2),
    });

    const settle = this.alpha * this.alpha;
    // Sized to fill the ring: the dish is the message, the ring is the clock.
    this.dish.scale.setScalar(1.15 * settle * pulse);
    this.dish.position.y = (1 - settle) * -0.15;
    // A slow turn, not a billboard. The camera never moves, so the dish is
    // already seen from the angle it was modelled for; rotating it just keeps
    // the bubble alive and shows off the side a plated dish usually hides.
    this.dish.rotation.y += dt * 0.7;
  }

  private setDish(recipeId: string): void {
    if (this.dishKey === recipeId) return;
    this.dishKey = recipeId;
    this.pop = 1;
    this.dish.clear();
    const recipe = RECIPE_BY_ID.get(recipeId);
    if (!recipe) return;
    // Not a simulation item — it has no id and never enters the world. The
    // model builder only reads base, processes and contents.
    const item: Item = {
      id: 0,
      base: recipe.dish.base,
      processes: [...recipe.dish.processes],
      contents: [],
    };
    const model = buildItemModel(item);
    // Models are built to sit on a surface; centre it in the ring instead.
    model.position.y = -0.06;
    this.dish.add(model);
    setLayer(this.dish, LAYER.UI);
  }

  dispose(parent: THREE.Object3D): void {
    parent.remove(this.object);
  }
}
