// Field paths pino-style: 'a.b.c' matches obj.a.b.c, 'a[*].secret' matches each element's .secret
export const REDACT_PATHS: string[] = [
  '*.token',
  '*.password',
  '*.api_key',
  '*.apiKey',
  '*.refresh_token',
  '*.refreshToken',
  '*.access_token',
  '*.accessToken',
  '*.bearer',
  '*.authorization',
  '*.Authorization',
  '*.secret',
  '*.client_secret',
  '*.clientSecret',
];
