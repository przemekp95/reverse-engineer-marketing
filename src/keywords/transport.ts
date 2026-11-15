import { GoogleAuth } from "google-auth-library";
import { GoogleKeywordError, type KeywordRequest } from "./contract.js";

export function safeKeywordError(error: unknown): GoogleKeywordError {
  if (error instanceof GoogleKeywordError) return error;
  const e = error as { response?: {status?:number;data?:{error?:{details?:Array<{errors?:Array<{errorCode?:Record<string,unknown>}>}>}}} };
  const details = e?.response?.data?.error?.details;
  if (Array.isArray(details)) for (const detail of details) for (const item of Array.isArray(detail?.errors) ? detail.errors : []) {
    for (const value of Object.values(item?.errorCode ?? {})) if (typeof value === "string" && /^[A-Z][A-Z0-9_]{0,80}$/.test(value)) {
      return new GoogleKeywordError(value, `Google keyword request denied (${value}); check Google Ads access level, account permissions and API configuration`);
    }
  }
  const status = e?.response?.status;
  const code = status === 401 ? "AUTH_ERROR" : status === 403 ? "ACCESS_DENIED" : status === 429 ? "RATE_LIMITED" : status && status >= 500 ? "UPSTREAM_UNAVAILABLE" : "GOOGLE_REQUEST_FAILED";
  return new GoogleKeywordError(code, `Google keyword request failed (${code}); check Google Ads access, credentials and configuration`);
}
export async function keywordTransport(request: KeywordRequest) {
  try {
    const auth = new GoogleAuth({ scopes:["https://www.googleapis.com/auth/adwords"], ...(request.credentialsFile ? {keyFilename:request.credentialsFile} : {}) });
    const client = await auth.getClient();
    const headers: Record<string,string> = {};
    if (request.projectId) headers["x-goog-user-project"] = request.projectId;
    if (request.loginCustomerId) headers["login-customer-id"] = request.loginCustomerId;
    return async (method: "generateKeywordIdeas" | "search", data: Record<string,unknown>): Promise<unknown> => {
      try {
        const path = method === "search" ? "/googleAds:search" : `:${method}`;
        const response = await client.request({url:`https://googleads.googleapis.com/v25/customers/${request.customerId}${path}`,method:"POST",data,headers,timeout:30_000,retry:false});
        return response.data;
      } catch (error) { throw safeKeywordError(error); }
    };
  } catch (error) { throw safeKeywordError(error); }
}
