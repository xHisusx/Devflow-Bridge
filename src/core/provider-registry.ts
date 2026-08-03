import type { Provider, PlaneProvider, PachkaProvider, WebhookProvider, ApiProvider, TaigaProvider, FormProvider } from "./config";

export class ProviderRegistry {
  private map = new Map<string, Provider>();

  constructor(providers: Provider[]) {
    for (const p of providers) {
      this.map.set(`${p.type}:${p.alias}`, p);
    }
  }

  get(ref: string): Provider | undefined {
    return this.map.get(ref);
  }

  getPlane(ref: string): PlaneProvider | undefined {
    const p = this.map.get(ref);
    return p?.type === "plane" ? p : undefined;
  }

  getPachka(ref: string): PachkaProvider | undefined {
    const p = this.map.get(ref);
    return p?.type === "pachka" ? p : undefined;
  }

  getWebhook(ref: string): WebhookProvider | undefined {
    const p = this.map.get(ref);
    return p?.type === "webhook" ? p : undefined;
  }

  getApi(ref: string): ApiProvider | undefined {
    const p = this.map.get(ref);
    return p?.type === "api" ? p : undefined;
  }

  getTaiga(ref: string): TaigaProvider | undefined {
    const p = this.map.get(ref);
    return p?.type === "taiga" ? p : undefined;
  }

  getForm(ref: string): FormProvider | undefined {
    const p = this.map.get(ref);
    return p?.type === "form" ? p : undefined;
  }

  getByType(type: string): Provider[] {
    return [...this.map.values()].filter((p) => p.type === type);
  }

  all(): Provider[] {
    return [...this.map.values()];
  }
}
