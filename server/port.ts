// Ports: the UI (Vite in development, this server in production) and the
// API. Override with PORT and API_PORT, e.g. to run a second instance.
export const uiPort = Number(process.env.PORT) || 4318;
export const apiPort = process.env.NODE_ENV === "production" ? uiPort : Number(process.env.API_PORT) || 4319;
/** Where agents reach the API (see the `reply` mutation). */
export const apiUrl = `http://127.0.0.1:${apiPort}`;
