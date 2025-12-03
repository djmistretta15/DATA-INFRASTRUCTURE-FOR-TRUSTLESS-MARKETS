import WebSocket, { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';
import Redis from 'redis';

/**
 * WebSocket Server for Real-Time Data Streaming
 * Provides real-time price updates, anomaly alerts, and pool updates
 */

interface Subscription {
  type: 'price' | 'anomaly' | 'pool' | 'slashing';
  ids: string[];
}

interface Client {
  ws: WebSocket;
  id: string;
  subscriptions: Subscription[];
  lastPing: number;
}

export class ReclaimWebSocketServer extends EventEmitter {
  private wss: WebSocketServer;
  private clients: Map<string, Client>;
  private redis: any;
  private readonly PING_INTERVAL = 30000; // 30 seconds
  private readonly PING_TIMEOUT = 10000; // 10 seconds

  constructor(port: number = 8080) {
    super();
    this.clients = new Map();
    this.wss = new WebSocketServer({ port });

    // Initialize Redis
    this.redis = Redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379'
    });
    this.redis.connect();

    this.setupWebSocketServer();
    this.setupRedisSubscriptions();
    this.startPingInterval();

    console.log(`🔌 WebSocket server listening on port ${port}`);
  }

  /**
   * Setup WebSocket server and connection handling
   */
  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      const clientId = this.generateClientId();
      const client: Client = {
        ws,
        id: clientId,
        subscriptions: [],
        lastPing: Date.now()
      };

      this.clients.set(clientId, client);
      console.log(`✓ Client connected: ${clientId} (${this.clients.size} total)`);

      // Send welcome message
      this.send(ws, {
        type: 'connected',
        clientId,
        timestamp: Date.now()
      });

      // Handle messages
      ws.on('message', (data: Buffer) => {
        this.handleMessage(client, data.toString());
      });

      // Handle pong
      ws.on('pong', () => {
        client.lastPing = Date.now();
      });

      // Handle close
      ws.on('close', () => {
        this.clients.delete(clientId);
        console.log(`✗ Client disconnected: ${clientId} (${this.clients.size} remaining)`);
      });

      // Handle error
      ws.on('error', (error) => {
        console.error(`WebSocket error for ${clientId}:`, error.message);
      });
    });
  }

  /**
   * Handle incoming client messages
   */
  private handleMessage(client: Client, data: string): void {
    try {
      const message = JSON.parse(data);

      switch (message.action) {
        case 'subscribe':
          this.handleSubscribe(client, message);
          break;

        case 'unsubscribe':
          this.handleUnsubscribe(client, message);
          break;

        case 'ping':
          this.send(client.ws, { type: 'pong', timestamp: Date.now() });
          break;

        default:
          this.send(client.ws, {
            type: 'error',
            message: `Unknown action: ${message.action}`
          });
      }
    } catch (error) {
      console.error('Error parsing message:', error);
      this.send(client.ws, {
        type: 'error',
        message: 'Invalid message format'
      });
    }
  }

  /**
   * Handle subscription requests
   */
  private handleSubscribe(client: Client, message: any): void {
    const { type, ids } = message;

    if (!type || !ids || !Array.isArray(ids)) {
      this.send(client.ws, {
        type: 'error',
        message: 'Invalid subscription format'
      });
      return;
    }

    // Check if subscription already exists
    const existing = client.subscriptions.find(s => s.type === type);

    if (existing) {
      // Add new IDs to existing subscription
      existing.ids.push(...ids.filter(id => !existing.ids.includes(id)));
    } else {
      // Create new subscription
      client.subscriptions.push({ type, ids });
    }

    this.send(client.ws, {
      type: 'subscribed',
      subscription: { type, ids },
      timestamp: Date.now()
    });

    console.log(`Client ${client.id} subscribed to ${type}: ${ids.join(', ')}`);
  }

  /**
   * Handle unsubscribe requests
   */
  private handleUnsubscribe(client: Client, message: any): void {
    const { type, ids } = message;

    if (!type) {
      this.send(client.ws, {
        type: 'error',
        message: 'Invalid unsubscribe format'
      });
      return;
    }

    if (ids) {
      // Remove specific IDs
      const subscription = client.subscriptions.find(s => s.type === type);
      if (subscription) {
        subscription.ids = subscription.ids.filter(id => !ids.includes(id));
        if (subscription.ids.length === 0) {
          client.subscriptions = client.subscriptions.filter(s => s.type !== type);
        }
      }
    } else {
      // Remove entire subscription type
      client.subscriptions = client.subscriptions.filter(s => s.type !== type);
    }

    this.send(client.ws, {
      type: 'unsubscribed',
      subscription: { type, ids },
      timestamp: Date.now()
    });

    console.log(`Client ${client.id} unsubscribed from ${type}`);
  }

  /**
   * Setup Redis pub/sub for real-time events
   */
  private async setupRedisSubscriptions(): Promise<void> {
    const subscriber = this.redis.duplicate();
    await subscriber.connect();

    // Subscribe to price updates
    await subscriber.subscribe('price:update', (message: string) => {
      const data = JSON.parse(message);
      this.broadcastToSubscribers('price', data.tokenId, {
        type: 'PRICE_UPDATE',
        data
      });
    });

    // Subscribe to anomaly alerts
    await subscriber.subscribe('anomaly:detected', (message: string) => {
      const data = JSON.parse(message);
      this.broadcastToSubscribers('anomaly', data.feedName, {
        type: 'ANOMALY_DETECTED',
        data
      });
    });

    // Subscribe to slashing events
    await subscriber.subscribe('slashing:event', (message: string) => {
      const data = JSON.parse(message);
      this.broadcast({
        type: 'SLASHING_EVENT',
        data
      });
    });

    // Subscribe to pool updates
    await subscriber.subscribe('pool:update', (message: string) => {
      const data = JSON.parse(message);
      this.broadcastToSubscribers('pool', data.poolAddress, {
        type: 'POOL_UPDATE',
        data
      });
    });

    console.log('✓ Redis subscriptions established');
  }

  /**
   * Broadcast message to subscribers of a specific type and ID
   */
  private broadcastToSubscribers(
    type: string,
    id: string,
    message: any
  ): void {
    let count = 0;

    for (const [_, client] of this.clients) {
      const subscription = client.subscriptions.find(
        s => s.type === type && s.ids.includes(id)
      );

      if (subscription && client.ws.readyState === WebSocket.OPEN) {
        this.send(client.ws, message);
        count++;
      }
    }

    if (count > 0) {
      console.log(`Broadcasted ${type} update to ${count} clients`);
    }
  }

  /**
   * Broadcast message to all connected clients
   */
  private broadcast(message: any): void {
    let count = 0;

    for (const [_, client] of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        this.send(client.ws, message);
        count++;
      }
    }

    console.log(`Broadcasted to ${count} clients`);
  }

  /**
   * Send message to a specific WebSocket
   */
  private send(ws: WebSocket, message: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Start ping interval to keep connections alive
   */
  private startPingInterval(): void {
    setInterval(() => {
      const now = Date.now();

      for (const [clientId, client] of this.clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          // Check if client responded to last ping
          if (now - client.lastPing > this.PING_TIMEOUT + this.PING_INTERVAL) {
            console.log(`Closing inactive client: ${clientId}`);
            client.ws.terminate();
            this.clients.delete(clientId);
          } else {
            // Send ping
            client.ws.ping();
          }
        } else {
          // Remove dead connections
          this.clients.delete(clientId);
        }
      }
    }, this.PING_INTERVAL);
  }

  /**
   * Generate unique client ID
   */
  private generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get server statistics
   */
  getStats(): any {
    const subscriptionsByType = new Map<string, number>();

    for (const [_, client] of this.clients) {
      for (const sub of client.subscriptions) {
        const count = subscriptionsByType.get(sub.type) || 0;
        subscriptionsByType.set(sub.type, count + 1);
      }
    }

    return {
      connectedClients: this.clients.size,
      subscriptions: Object.fromEntries(subscriptionsByType),
      uptime: process.uptime()
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    console.log('Shutting down WebSocket server...');

    // Close all client connections
    for (const [_, client] of this.clients) {
      this.send(client.ws, {
        type: 'server_shutdown',
        message: 'Server is shutting down'
      });
      client.ws.close();
    }

    // Close WebSocket server
    this.wss.close();

    // Disconnect Redis
    await this.redis.quit();

    console.log('✓ WebSocket server shut down');
  }
}

// Start server if run directly
if (require.main === module) {
  const port = parseInt(process.env.WS_PORT || '8080');
  const server = new ReclaimWebSocketServer(port);

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    await server.shutdown();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await server.shutdown();
    process.exit(0);
  });

  // Health check endpoint
  const http = require('http');
  const healthServer = http.createServer((_req: any, res: any) => {
    const stats = server.getStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', ...stats }));
  });

  healthServer.listen(port + 1, () => {
    console.log(`Health check available on port ${port + 1}`);
  });
}

export default ReclaimWebSocketServer;
