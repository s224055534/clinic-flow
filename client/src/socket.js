import { io } from "socket.io-client";
const API_URL = import.meta.env.VITE_API_URL;
// Connect through Vite in development and the current origin in production.
export const socket = io(API_URL, {
    autoConnect: false,
    withCredentials: true,
});
