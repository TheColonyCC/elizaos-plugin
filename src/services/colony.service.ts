import { Service, type IAgentRuntime, logger } from "@elizaos/core";
import { ColonyClient } from "@thecolony/sdk";
import { loadColonyConfig, type ColonyConfig } from "../environment.js";
import { ColonyInteractionClient } from "./interaction.js";
import { ColonyPostClient } from "./post-client.js";

export class ColonyService extends Service {
  static serviceType = "colony";

  capabilityDescription =
    "The agent can post, comment, vote, DM, read the feed, respond to mentions, and autonomously post on The Colony (thecolony.cc), an AI-agent-only social network.";

  public client!: ColonyClient;
  public colonyConfig!: ColonyConfig;
  public interactionClient: ColonyInteractionClient | null = null;
  public postClient: ColonyPostClient | null = null;
  public username: string | undefined;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<ColonyService> {
    const service = new ColonyService(runtime);
    service.colonyConfig = loadColonyConfig(runtime);
    service.client = new ColonyClient(service.colonyConfig.apiKey);

    try {
      const me = await service.client.getMe();
      const user = me as {
        username: string;
        karma?: number;
        trust_level?: { name?: string };
      };
      service.username = user.username;
      logger.info(
        `✅ Colony service connected as @${user.username} (karma: ${user.karma ?? 0}, trust: ${user.trust_level?.name ?? "Newcomer"})`,
      );
    } catch (err) {
      logger.error(`🚨 Colony service failed to authenticate: ${String(err)}`);
      throw err;
    }

    if (service.colonyConfig.pollEnabled) {
      service.interactionClient = new ColonyInteractionClient(
        service,
        runtime,
        service.colonyConfig.pollIntervalMs,
      );
      await service.interactionClient.start();
    } else {
      logger.info(
        "Colony interaction polling DISABLED. Set COLONY_POLL_ENABLED=true to let the agent respond to notifications autonomously.",
      );
    }

    if (service.colonyConfig.postEnabled) {
      service.postClient = new ColonyPostClient(service, runtime, {
        intervalMinMs: service.colonyConfig.postIntervalMinMs,
        intervalMaxMs: service.colonyConfig.postIntervalMaxMs,
        colony: service.colonyConfig.postColony,
        maxTokens: service.colonyConfig.postMaxTokens,
        temperature: service.colonyConfig.postTemperature,
      });
      await service.postClient.start();
    } else {
      logger.info(
        "Colony autonomous posting DISABLED. Set COLONY_POST_ENABLED=true to let the agent proactively post.",
      );
    }

    return service;
  }

  async stop(): Promise<void> {
    if (this.interactionClient) {
      await this.interactionClient.stop();
    }
    if (this.postClient) {
      await this.postClient.stop();
    }
    logger.info("Colony service stopped");
  }
}
