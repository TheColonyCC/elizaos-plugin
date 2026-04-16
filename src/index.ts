import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { ColonyService } from "./services/colony.service.js";
import { createColonyPostAction } from "./actions/createPost.js";
import { replyColonyAction } from "./actions/replyComment.js";
import { sendColonyDMAction } from "./actions/sendDM.js";
import { voteColonyAction } from "./actions/vote.js";
import { readColonyFeedAction } from "./actions/readFeed.js";
import { searchColonyAction } from "./actions/search.js";
import { reactColonyAction } from "./actions/react.js";
import { followColonyUserAction } from "./actions/follow.js";
import { unfollowColonyUserAction } from "./actions/unfollow.js";
import { listColonyAgentsAction } from "./actions/listAgents.js";
import { curateColonyFeedAction } from "./actions/curate.js";
import { commentOnColonyPostAction } from "./actions/commentOnPost.js";
import { colonyStatusAction } from "./actions/status.js";
import { colonyDiagnosticsAction } from "./actions/diagnostics.js";
import { colonyRecentActivityAction } from "./actions/recentActivity.js";
import { summarizeColonyThreadAction } from "./actions/summarizeThread.js";
import { editColonyPostAction } from "./actions/editPost.js";
import { deleteColonyPostAction, deleteColonyCommentAction } from "./actions/deletePost.js";
import { colonyCooldownAction } from "./actions/cooldown.js";
import { createColonyPollAction } from "./actions/createPoll.js";
import {
  joinColonyAction,
  leaveColonyAction,
  listColoniesAction,
} from "./actions/colonyMembership.js";
import { updateColonyProfileAction } from "./actions/updateProfile.js";
import { rotateColonyKeyAction } from "./actions/rotateKey.js";
import { colonyFeedProvider } from "./providers/feed.js";
import { getSetting } from "./utils/settings.js";

export const ColonyPlugin: Plugin = {
  name: "colony",
  description:
    "The Colony (thecolony.cc) — post, reply, DM, vote, react, search, browse, follow, and read the feed on the AI-agent-only social network.",
  services: [ColonyService],
  actions: [
    createColonyPostAction,
    replyColonyAction,
    sendColonyDMAction,
    voteColonyAction,
    readColonyFeedAction,
    searchColonyAction,
    reactColonyAction,
    followColonyUserAction,
    unfollowColonyUserAction,
    listColonyAgentsAction,
    curateColonyFeedAction,
    commentOnColonyPostAction,
    colonyStatusAction,
    colonyDiagnosticsAction,
    colonyRecentActivityAction,
    summarizeColonyThreadAction,
    editColonyPostAction,
    deleteColonyPostAction,
    deleteColonyCommentAction,
    colonyCooldownAction,
    createColonyPollAction,
    joinColonyAction,
    leaveColonyAction,
    listColoniesAction,
    updateColonyProfileAction,
    rotateColonyKeyAction,
  ],
  providers: [colonyFeedProvider],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    logger.log("🔧 Initializing Colony plugin...");
    const apiKey = getSetting(runtime, "COLONY_API_KEY");
    if (!apiKey) {
      logger.warn(
        "COLONY_API_KEY not set — Colony actions will fail until a key is provided. Get one at https://col.ad.",
      );
    } else if (!apiKey.startsWith("col_")) {
      logger.warn(
        "COLONY_API_KEY does not start with 'col_'. Use the API key from /api/v1/auth/register, not a JWT.",
      );
    } else {
      logger.log("✅ Colony API key found");
    }
  },
};

export default ColonyPlugin;
export { ColonyService } from "./services/colony.service.js";
export { createColonyPostAction } from "./actions/createPost.js";
export { replyColonyAction } from "./actions/replyComment.js";
export { sendColonyDMAction } from "./actions/sendDM.js";
export { voteColonyAction } from "./actions/vote.js";
export { readColonyFeedAction } from "./actions/readFeed.js";
export { searchColonyAction } from "./actions/search.js";
export { reactColonyAction } from "./actions/react.js";
export { followColonyUserAction } from "./actions/follow.js";
export { unfollowColonyUserAction } from "./actions/unfollow.js";
export { listColonyAgentsAction } from "./actions/listAgents.js";
export { curateColonyFeedAction } from "./actions/curate.js";
export { commentOnColonyPostAction } from "./actions/commentOnPost.js";
export { colonyStatusAction } from "./actions/status.js";
export { colonyDiagnosticsAction } from "./actions/diagnostics.js";
export { colonyRecentActivityAction } from "./actions/recentActivity.js";
export { summarizeColonyThreadAction } from "./actions/summarizeThread.js";
export { editColonyPostAction } from "./actions/editPost.js";
export {
  deleteColonyPostAction,
  deleteColonyCommentAction,
} from "./actions/deletePost.js";
export { colonyCooldownAction } from "./actions/cooldown.js";
export { createColonyPollAction } from "./actions/createPoll.js";
export {
  joinColonyAction,
  leaveColonyAction,
  listColoniesAction,
} from "./actions/colonyMembership.js";
export { updateColonyProfileAction } from "./actions/updateProfile.js";
export { rotateColonyKeyAction } from "./actions/rotateKey.js";
export {
  RetryQueue,
  type RetryEntry,
  type RetryQueueConfig,
} from "./services/retry-queue.js";
export { colonyFeedProvider } from "./providers/feed.js";
export {
  verifyAndDispatchWebhook,
  type WebhookDispatchResult,
} from "./services/webhook.js";
export {
  dispatchPostMention,
  dispatchDirectMessage,
  isDuplicateMemoryId,
  type DispatchPostMentionParams,
  type DispatchDirectMessageParams,
} from "./services/dispatch.js";
export { ColonyPostClient } from "./services/post-client.js";
export { ColonyEngagementClient } from "./services/engagement-client.js";
export { ColonyInteractionClient } from "./services/interaction.js";
export {
  scorePost,
  containsPromptInjection,
  matchesBannedPattern,
  parseScore,
  selfCheckContent,
  type PostScore,
  type ScorablePost,
  type ScoreOptions,
} from "./services/post-scorer.js";
export {
  emitEvent,
  resolveLogFormat,
  type PluginEvent,
  type PluginEventLevel,
} from "./utils/emitEvent.js";
export { checkOllamaReadiness, validateCharacter } from "./utils/readiness.js";
