import * as THREE from "three";
import { applianceDef } from "../data/appliances";
import { canPlace, targetTile } from "../sim/systems/interaction";
import type { World } from "../sim/types";
import { applianceAtTile } from "../sim/world";
import type { ApplianceViews } from "./appliance-views";
import { disposeSubtree } from "./dispose";
import { buildHighlight } from "./meshes";
import { PALETTE } from "./palette";
import type { PeopleViews } from "./people-views";

/**
 * The square in front of each chef: what they would interact with.
 *
 * It is also the build phase's yes/no. Red means the appliance you are carrying
 * will not go here, and it uses `canPlace` — the simulation's own rule — so the
 * preview and the thing it previews cannot disagree.
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

      const tile = targetTile(player);
      const inside = tile.x >= 0 && tile.y >= 0 && tile.x < world.width && tile.y < world.height;
      mesh.visible = inside;
      if (!inside) continue;

      const appliance = applianceAtTile(world, tile.x, tile.y);
      const height = appliance ? applianceDef(appliance.kind).height + 0.1 : 0.03;
      mesh.position.set(tile.x + 0.5, height, tile.y + 0.5);

      // Name the thing you're pointing at, and only that thing — but yield to
      // the progress dial, which occupies the same space and says more.
      if (appliance && appliance.progress <= 0.001) {
        this.appliances.showLabel(appliance.id);
      }

      const placing = world.phase === "build" && player.carriedAppliance !== null;
      const blocked = placing && !canPlace(world, tile.x, tile.y);
      const material = basicMaterial(mesh);
      material.color.setHex(
        blocked
          ? PALETTE.progressBurn
          : world.phase === "build"
            ? PALETTE.progressGood
            : this.people.colorOf(player.id),
      );
      material.opacity = blocked ? 0.7 : appliance ? 0.75 : 0.28;
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
