import { cookies } from "next/headers";
import { getIronSession, type IronSession } from "iron-session";
import { getSessionOptions, type AdminSessionData } from "./sessionOptions";

export type { AdminSessionData };
export { getSessionOptions };

export async function getAdminSession(): Promise<IronSession<AdminSessionData>> {
  const cookieStore = await cookies();
  return getIronSession<AdminSessionData>(cookieStore, getSessionOptions());
}

export { CSRF_HEADER, hasCsrfHeader } from "./csrf";
