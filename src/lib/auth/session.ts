import { cookies } from "next/headers";
import { getIronSession, type IronSession } from "iron-session";
import { sessionOptions, type AdminSessionData } from "./sessionOptions";

export type { AdminSessionData };
export { sessionOptions };

export async function getAdminSession(): Promise<IronSession<AdminSessionData>> {
  const cookieStore = await cookies();
  return getIronSession<AdminSessionData>(cookieStore, sessionOptions);
}

export { CSRF_HEADER, hasCsrfHeader } from "./csrf";
