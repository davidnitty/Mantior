import axios, { type AxiosInstance, type AxiosError } from 'axios';

import {
  BaseConnector,
  type ConnectorConfig,
  type ConnectorRequest,
  type ConnectorResponse,
} from './base';

export class RESTConnector extends BaseConnector {
  private readonly client: AxiosInstance;

  constructor(config: ConnectorConfig) {
    super(config);
    this.client = axios.create({
      timeout: config.timeout,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mantior/1.0' },
    });
  }

  request(req: ConnectorRequest): Promise<ConnectorResponse> {
    return this.executeWithRetries(async () => {
      const startTime = Date.now();
      try {
        const response = await this.client.request({
          method: req.method,
          url: req.url,
          headers: req.headers,
          data: req.body,
          timeout: req.timeout ?? this.config.timeout,
        });
        return {
          status: response.status,
          headers: response.headers as Record<string, string>,
          body: response.data as unknown,
          duration: Date.now() - startTime,
        };
      } catch (error) {
        const axiosError = error as AxiosError;
        if (axiosError.response) {
          return {
            status: axiosError.response.status,
            headers: axiosError.response.headers as Record<string, string>,
            body: axiosError.response.data,
            duration: Date.now() - startTime,
          };
        }
        throw error;
      }
    }, `REST ${req.method} ${req.url}`);
  }
}
