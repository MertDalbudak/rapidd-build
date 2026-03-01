export interface ModelField {
  type: string;
  optional: boolean;
  isArray: boolean;
  isRelation: boolean;
  isId?: boolean;
  isUnique?: boolean;
  isUpdatedAt?: boolean;
  hasDefaultValue?: boolean;
  attributes?: string;
  kind?: string;
  relationName?: string;
  relationFromFields?: string[];
  relationToFields?: string[];
}

export interface ModelRelation {
  name: string;
  type: string;
  isArray: boolean;
  optional: boolean;
  relationName?: string;
  relationFromFields?: string[];
  relationToFields?: string[];
  kind?: string;
}

export interface ModelInfo {
  name: string;
  fields: Record<string, ModelField>;
  relations: ModelRelation[];
  compositeKey: string[] | null;
  dbName: string;
}
