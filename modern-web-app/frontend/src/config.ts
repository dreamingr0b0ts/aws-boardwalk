import { Amplify } from 'aws-amplify';

export interface AppConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
}

let config: AppConfig | null = null;

/**
 * Runtime configuration: /config.json is generated from Terraform outputs at
 * deploy time and uploaded next to the static assets, so the same build works
 * in any account/environment — no baked-in IDs.
 */
export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error('config.json missing — run `make publish` so deploy writes it from Terraform outputs');
  }
  config = (await res.json()) as AppConfig;

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
      },
    },
  });

  return config;
}

export function getConfig(): AppConfig {
  if (!config) throw new Error('config not loaded');
  return config;
}
