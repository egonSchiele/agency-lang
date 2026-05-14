import type {
  Entity,
  Observation,
  Relation,
  MemoryGraphData,
} from "./types.js";

export class MemoryGraph {
  private entities: Entity[] = [];
  private relations: Relation[] = [];
  private nextId = 1;

  private genId(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  private now(): string {
    return new Date().toISOString();
  }

  getEntities(): Entity[] {
    return this.entities;
  }

  getRelations(): Relation[] {
    return this.relations;
  }

  getEntity(id: string): Entity | null {
    return this.entities.find((e) => e.id === id) ?? null;
  }

  addEntity(name: string, type: string, source: string): Entity {
    const entity: Entity = {
      id: this.genId("entity"),
      name,
      type,
      source,
      createdAt: this.now(),
      observations: [],
    };
    this.entities.push(entity);
    return entity;
  }

  addObservation(entityId: string, content: string): Observation {
    const entity = this.getEntity(entityId);
    if (!entity) throw new Error(`Entity ${entityId} not found`);
    const obs: Observation = {
      id: this.genId("obs"),
      content,
      validFrom: this.now(),
      validTo: null,
    };
    entity.observations.push(obs);
    return obs;
  }

  expireObservation(obsId: string): void {
    for (const entity of this.entities) {
      const obs = entity.observations.find((o) => o.id === obsId);
      if (obs) {
        obs.validTo = this.now();
        return;
      }
    }
  }

  addRelation(
    fromId: string,
    toId: string,
    type: string,
    source: string
  ): Relation {
    const rel: Relation = {
      id: this.genId("rel"),
      from: fromId,
      to: toId,
      type,
      source,
      validFrom: this.now(),
      validTo: null,
    };
    this.relations.push(rel);
    return rel;
  }

  expireRelation(relId: string): void {
    const rel = this.relations.find((r) => r.id === relId);
    if (rel) rel.validTo = this.now();
  }

  findEntityByName(name: string): Entity | null {
    const lower = name.toLowerCase();
    return this.entities.find((e) => e.name.toLowerCase() === lower) ?? null;
  }

  findEntitiesByType(type: string): Entity[] {
    return this.entities.filter((e) => e.type === type);
  }

  getCurrentObservations(entityId: string): Observation[] {
    const entity = this.getEntity(entityId);
    if (!entity) return [];
    return entity.observations.filter((o) => o.validTo === null);
  }

  getRelationsFrom(entityId: string): Relation[] {
    return this.relations.filter(
      (r) => r.from === entityId && r.validTo === null
    );
  }

  getRelationsTo(entityId: string): Relation[] {
    return this.relations.filter(
      (r) => r.to === entityId && r.validTo === null
    );
  }

  toCompactIndex(): string {
    const lines: string[] = [];
    for (const entity of this.entities) {
      const current = this.getCurrentObservations(entity.id);
      const obsStr = current.map((o) => o.content).join("; ");
      const relFrom = this.getRelationsFrom(entity.id);
      const relStr = relFrom
        .map((r) => {
          const target = this.getEntity(r.to);
          return `${r.type} → ${target?.name ?? r.to}`;
        })
        .join("; ");
      let line = `${entity.name} (${entity.type})`;
      if (obsStr) line += `: ${obsStr}`;
      if (relStr) line += ` [${relStr}]`;
      lines.push(line);
    }
    return lines.join("\n");
  }

  toJSON(): MemoryGraphData {
    return {
      entities: this.entities,
      relations: this.relations,
      nextId: this.nextId,
    };
  }

  static fromJSON(data: MemoryGraphData): MemoryGraph {
    const graph = new MemoryGraph();
    graph.entities = data.entities;
    graph.relations = data.relations;
    graph.nextId = data.nextId;
    return graph;
  }
}
