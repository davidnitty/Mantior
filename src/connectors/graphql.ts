import {
  BaseConnector,
  type ConnectorConfig,
  type ConnectorRequest,
  type ConnectorResponse,
} from './base';

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export class GraphQLConnector extends BaseConnector {
  private readonly endpoint: string;

  constructor(config: ConnectorConfig & { endpoint: string }) {
    super(config);
    this.endpoint = config.endpoint;
  }

  request(req: ConnectorRequest): Promise<ConnectorResponse> {
    return this.query(req.body as GraphQLRequest);
  }

  query(request: GraphQLRequest): Promise<ConnectorResponse> {
    return this.executeWithRetries(
      async () => {
        const startTime = Date.now();
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        });
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: await response.json(),
          duration: Date.now() - startTime,
        };
      },
      `GraphQL ${request.operationName ?? 'anonymous'}`,
    );
  }
}
