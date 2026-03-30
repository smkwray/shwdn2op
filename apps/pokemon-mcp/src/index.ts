import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import { effectivenessFor, findMove, findPokemon } from "./data.js";

const server = new Server(
  {
    name: "showdnass-pokemon-mcp",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "lookup_pokemon",
        description: "Look up seeded species data: types, roles, common items, common moves, and common Tera types.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" }
          },
          required: ["name"],
          additionalProperties: false
        }
      },
      {
        name: "lookup_move",
        description: "Look up seeded move data: type, category, and base power.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" }
          },
          required: ["name"],
          additionalProperties: false
        }
      },
      {
        name: "type_effectiveness",
        description: "Calculate type effectiveness multiplier for an attacking type into one or more defending types.",
        inputSchema: {
          type: "object",
          properties: {
            attackingType: { type: "string" },
            defendingTypes: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 3
            }
          },
          required: ["attackingType", "defendingTypes"],
          additionalProperties: false
        }
      },
      {
        name: "common_sets",
        description: "Return the same seeded species data with emphasis on likely roles and common move packages.",
        inputSchema: {
          type: "object",
          properties: {
            pokemon: { type: "string" },
            format: { type: "string" }
          },
          required: ["pokemon"],
          additionalProperties: false
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  if (name === "lookup_pokemon") {
    const result = findPokemon(String(args.name ?? ""));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            result ?? { error: "Pokemon not found in seed data." },
            null,
            2
          )
        }
      ]
    };
  }

  if (name === "lookup_move") {
    const result = findMove(String(args.name ?? ""));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            result ?? { error: "Move not found in seed data." },
            null,
            2
          )
        }
      ]
    };
  }

  if (name === "type_effectiveness") {
    const result = effectivenessFor(
      String(args.attackingType ?? ""),
      Array.isArray(args.defendingTypes)
        ? args.defendingTypes.map((value) => String(value))
        : []
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  }

  if (name === "common_sets") {
    const pokemon = findPokemon(String(args.pokemon ?? ""));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            pokemon
              ? {
                  pokemon: pokemon.name,
                  format: args.format ?? null,
                  tier: pokemon.tier ?? null,
                  types: pokemon.types,
                  likelyRoles: pokemon.roles,
                  commonMoves: pokemon.commonMoves,
                  commonItems: pokemon.commonItems,
                  commonTeraTypes: pokemon.commonTeraTypes,
                  note:
                    args.format && String(args.format).toLowerCase().includes("uu")
                      ? "Deterministic species data comes from @pkmn/*; role and common-set hints remain curated and should be verified against current Gen 9 UU trends."
                      : "Deterministic species data comes from @pkmn/*; role and common-set hints remain curated."
                }
              : { error: "Pokemon not found in seed data." },
            null,
            2
          )
        }
      ]
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: `Unknown tool: ${String(name)}` }, null, 2)
      }
    ],
    isError: true
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
