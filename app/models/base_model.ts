import { BaseModel as LucidBaseModel, SnakeCaseNamingStrategy } from '@adonisjs/lucid/orm'

export default class BaseModel extends LucidBaseModel {
  static namingStrategy = new SnakeCaseNamingStrategy()
  toJSON() {
    const data = super.toJSON()
    return this.cleanObject(data)
  }

  private cleanObject(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map((item) => this.cleanObject(item)).filter(item => item !== null);
    } else if (typeof obj === 'object' && obj !== null) {
      const entries = Object.entries(obj)
        .map(([key, value]) => [key, this.cleanObject(value)])
        .filter(([_, value]) => value !== null);

      if (Object.keys(obj).length > 0 && entries.length === 0) {
        return null;
      }

      return Object.fromEntries(entries);
    }
    return obj;
  }
}