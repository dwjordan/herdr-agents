import streamDeck from "@elgato/streamdeck";
import { AgentsAction } from "./actions/agents-action";

streamDeck.actions.registerAction(new AgentsAction());

streamDeck.connect();
