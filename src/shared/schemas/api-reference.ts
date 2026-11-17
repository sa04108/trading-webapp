export interface ApiParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  type: string;
  required: boolean;
  description: string;
  example?: unknown;
}
export interface ApiEndpoint {
  id: string;
  method: string;
  path: string;
  group: string;
  title: string;
  description: string;
  authentication: 'PUBLIC' | 'SESSION' | 'SESSION_OR_TOKEN' | 'AGENT_TOKEN' | 'INSTALLATION_GRANT';
  parameters: ApiParameter[];
  requestBody?: { contentType: string; schema?: Record<string, unknown>; example?: unknown; description: string };
  responses: Array<{ status: number | string; description: string; contentType?: string; schema?: Record<string, unknown>; example?: unknown }>;
}
export interface ApiReference {
  version: '1';
  generatedAtMs: number;
  basePath: '/api/v1';
  authentication: { description: string; bearerExample: string; tokenManagement: string };
  endpoints: ApiEndpoint[];
}
