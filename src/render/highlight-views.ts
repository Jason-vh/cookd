import * as THREE from "three";
import { canPlace, reachedTile } from "../sim/queries";
import type { World } from "../sim/types";
import { applianceAtTile } from "../sim/world";
import type { ApplianceViews } from "./appliance-views";
import { disposeSubtree } from "./dispose";
import { buildHighlight } from "./overlay-meshes";
import { PALETTE } from "./palette";
import type { PeopleViews } from "./people-views";

/**
 * What each chef would interact with: the object itself, lit up.
 *
 * It used to be a translucent square floating above whatever was being pointed
 * at, and that asks the player to make the connection: the square is over the
 * oven, so it must mean the oven. Lighting the oven *is* the statement, and
 * there is nothing to work out at a glance in the middle of a rush.
 *
 * The square survives for the one case that has no object to light — an empty
 * tile — where where-you-are-pointing is the whole of what has to be said.
 *
 * Either way it is also the build phase's yes/no. Red means the appliance you
 * are carrying will not go here, and it uses `canPlace` — the simulation's own
 * rule — so the preview and the thing it previews cannot disagree.
 */
export class HighlightViews {
  private readonly meshes = new Map<number, THREE.Mesh>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly appliances: ApplianceViews,
    private readonly people: PeopleViews,
  ) {}

  sync(world: World): void {
    for (const [id, mesh] of this.meshes) {
      if (world.players.some((player) => player.id === id)) continue;
      disposeSubtree(mesh);
      this.meshes.delete(id);
    }

    for (const player of world.players) {
      let mesh = this.meshes.get(player.id);
      if (!mesh) {
        // Colour is set every frame below, so the constructor argument only has
        // to be *a* colour. It used to be indexed off `this.meshes.size`, on a
        // different basis from the per-frame recolour, and was therefore always
        // immediately overwritten — dead code that looked like a decision.
        mesh = buildHighlight(PALETTE.progressGood);
        this.scene.add(mesh);
        this.meshes.set(player.id, mesh);
      }

      // Nothing to point at through a wall: the square goes out rather than
      // sitting on a tile the chef cannot touch.
      const tile = reachedTile(world, player);
      const inside =
        tile !== null &&
        tile.x >= 0 &&
        tile.y >= 0 &&
        tile.x < world.width &&
        tile.y < world.height;
      mesh.visible = inside;
      if (!tile || !inside) continue;

      const appliance = applianceAtTile(world, tile.x, tile.y);

      // Name the thing you're pointing at, and only that thing — but yield to
      // the progress dial, which occupies the same space and says more.
      if (appliance && appliance.progress <= 0.001) {
        this.appliances.showLabel(appliance.id);
      }

      // What is in your hands decides where it will go: a board wants a bare
      // worktop where an oven wants a bare tile, so the square has to be asked
      // about the thing being carried rather than about appliances in general.
      const held =
        player.carriedAppliance === null
          ? undefined
          : world.appliances.get(player.carriedAppliance);
      const placing = world.phase === "build" && held !== undefined;
      const blocked = placing && held !== undefined && !canPlace(world, tile.x, tile.y, held.kind);
      // Whose chef is pointing, except in the build phase, where what matters is
      // whether the thing in your hands will go there and not who is asking.
      const color = blocked
        ? PALETTE.progressBurn
        : world.phase === "build"
          ? PALETTE.progressGood
          : this.people.colorOf(player.id);

      // An occupied tile lights its occupant; an empty one gets the square. A
      // refused placement over an appliance therefore turns *that appliance*
      // red, which is the thing in the way and so the thing to say it about.
      mesh.visible = appliance === null;
      if (appliance) {
        this.appliances.highlight(appliance.id, color);
        continue;
      }

      mesh.position.set(tile.x + 0.5, 0.03, tile.y + 0.5);
      const material = basicMaterial(mesh);
      material.color.setHex(color);
      material.opacity = blocked ? 0.7 : 0.3;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) disposeSubtree(mesh);
    this.meshes.clear();
  }
}

function basicMaterial(mesh: THREE.Mesh): THREE.MeshBasicMaterial {
  if (Array.isArray(mesh.material) || !(mesh.material instanceof THREE.MeshBasicMaterial)) {
    throw new Error("highlight lost its material");
  }
  return mesh.material;
}
