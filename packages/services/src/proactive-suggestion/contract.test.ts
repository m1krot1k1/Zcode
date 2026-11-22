import { ServiceChannels } from "@zcode/shared";
import { describe, expect, it } from "vitest";

import { IProactiveSuggestionService } from "./contract.js";
import { proactiveSuggestionModule } from "./module.js";

describe("services-proactive-suggestion contract", () => {
  it("declares its module manifest", () => {
    expect(proactiveSuggestionModule.id).toBe("services-proactive-suggestion");
  });

  it("binds the descriptor to the shared channel", () => {
    expect(IProactiveSuggestionService.channelName).toBe(ServiceChannels.ProactiveSuggestion);
    expect(ServiceChannels.ProactiveSuggestion).toBe("proactive-suggestion");
  });
});
