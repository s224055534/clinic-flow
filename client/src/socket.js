import { io } from "socket.io-client";

// Connect through Vite in development and the current origin in production.
export const socket = io({ autoConnect: false });
