'use client';

import { use } from "react";
import { notFound } from "next/navigation";
import { findAgent } from "@/lib/agents/catalog";
import { AgentChatPage } from "@/app/pages/agent-chat";

export default function AgentRoute({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = use(params);
  const agent = findAgent(agentId);
  if (!agent) notFound();
  // key: switching agents starts a fresh conversation (new hook state, new conversationId).
  return <AgentChatPage key={agent.id} agent={agent} />;
}
