import { afterEach, describe, expect, it, jest } from '@jest/globals';
import axios from 'axios';

import { Notifier } from './notifier';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('Notifier', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('posts Slack messages when a webhook is configured', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 });
    const notifier = new Notifier('https://hooks.slack.com/services/xxx');
    await notifier.notify({ text: 'scan finished', fields: { status: 'success' } });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/xxx',
      expect.objectContaining({ text: 'scan finished' }),
      expect.any(Object),
    );
  });

  it('is a no-op without a webhook', async () => {
    const notifier = new Notifier();
    await notifier.notify({ text: 'hello' });

    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('swallows delivery failures', async () => {
    mockedAxios.post.mockRejectedValue(new Error('network down'));
    const notifier = new Notifier('https://hooks.slack.com/services/xxx');
    await expect(notifier.notify({ text: 'boom' })).resolves.toBeUndefined();
  });
});
