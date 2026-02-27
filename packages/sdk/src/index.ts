export interface CalyxExtensionManifest {
  name: string;
  version: string;
  calyx: {
    apiVersion: string;
    domains: string[];
  };
}
