import { DirectoryData, Result } from '../../frontend/src/types';
import { URL } from 'url';
import fetch from 'node-fetch';
import * as AWS from 'aws-sdk';
import { region } from './config';

const TRELLO_URL = process.env.TRELLO_URL || 'https://api.trello.com/1';
const TRELLO_SECRET_ID = process.env.TRELLO_SECRET_ID;
const TRELLO_TEAM = process.env.TRELLO_TEAM;

const sm = new AWS.SecretsManager({ region });
const getSecretParams: AWS.SecretsManager.GetSecretValueRequest = {
  SecretId: TRELLO_SECRET_ID,
};

let cachedSecretResponse: AWS.SecretsManager.GetSecretValueResponse | undefined;

async function getTrelloCredentials(): Promise<{
  apiKey: string;
  token: string;
}> {
  const { TRELLO_API_KEY, TRELLO_TOKEN } = process.env;
  if (TRELLO_API_KEY && TRELLO_TOKEN) {
    return {
      apiKey: TRELLO_API_KEY,
      token: TRELLO_TOKEN,
    };
  }
  cachedSecretResponse =
    cachedSecretResponse ||
    (await sm.getSecretValue(getSecretParams).promise());

  const parsedSecrets = JSON.parse(cachedSecretResponse.SecretString);
  return {
    apiKey: parsedSecrets.trello_api_key,
    token: parsedSecrets.trello_token,
  };
}

export interface TrelloCard {
  id?: string;
  name: string;
  category: string;
  description: string;
  questions?: string;
  tags: string;
  listId?: string;
  checklists?: TrelloCheckList[];
}

export interface TrelloCheckList {
  name: string;
  items: TrelloCheckListItem[];
}

export interface TrelloCheckListItem {
  name: string;
  completed: boolean;
}

async function buildURL(
  resourcePath: string,
  params: Map<string, string> = new Map([]),
): Promise<string> {
  const trelloCredentials = await getTrelloCredentials();
  const url = new URL(`${TRELLO_URL}/${resourcePath}`);

  url.searchParams.append('key', trelloCredentials.apiKey);
  url.searchParams.append('token', trelloCredentials.token);

  for (const [key, value] of params) {
    url.searchParams.append(key, value);
  }

  return url.toString();
}

export async function createBoard(name: string): Promise<any> {
  const params = new Map([
    ['name', name],
    ['defaultLists', 'false'],
    ['defaultLabels', 'false'],
    ['idOrganization', TRELLO_TEAM], // The Listo Trello team
    ['prefs_permissionLevel', 'enterprise'], // All users within the Trello org have read access to all boards.
  ]);
  const url = await buildURL('boards', params);
  const options = {
    method: 'POST',
  };

  const res = await fetch(url, options);

  return res.json();
}

export async function deleteBoard(id: string): Promise<any> {
  const url = await buildURL(`boards/${id}`);
  const options = {
    method: 'DELETE',
  };
  return fetch(url, options);
}

export async function createLists(
  names: string[],
  boardId: string,
): Promise<any[]> {
  const options = {
    method: 'POST',
  };

  const responses = names.map(async name => {
    const params = new Map([
      ['idBoard', boardId],
      ['name', name],
    ]);
    const url = await buildURL('lists', params);

    return fetch(url, options);
  });

  // Done list
  const params = new Map([
    ['idBoard', boardId],
    ['name', 'Done'],
    ['pos', 'bottom'],
  ]);
  const url = await buildURL('lists', params);
  const doneResponse = fetch(url, options);
  responses.push(doneResponse);

  const awaitedResponses = await Promise.all(responses);

  return Promise.all(awaitedResponses.map(response => response.json()));
}

export async function createCards(
  cards: TrelloCard[],
): Promise<Promise<any>[]> {
  const responses = await Promise.all(
    cards.map(async card => {
      const params = new Map([
        ['idList', card.listId],
        ['name', card.name],
        ['desc', card.description],
      ]);
      const url = await buildURL('cards', params);

      const options = {
        method: 'POST',
      };

      return fetch(url, options);
    }),
  );

  return Promise.all(responses.map(response => response.json()));
}

export async function createCheckList(
  checklist: TrelloCheckList,
  cardId: string,
): Promise<Promise<any>[]> {
  const params = new Map([
    ['idCard', cardId],
    ['name', checklist.name],
  ]);
  const url = await buildURL('checklists', params);

  const options = {
    method: 'POST',
  };

  const res = await (await fetch(url, options)).json();

  const responses = await Promise.all(
    checklist.items.map(async item => {
      const params = new Map([
        ['name', item.name],
        ['checked', `${item.completed}`],
      ]);
      const url = await buildURL(`checklists/${res.id}/checkItems`, params);

      const options = {
        method: 'POST',
      };

      return fetch(url, options);
    }),
  );

  return Promise.all(responses.map(response => response.json()));
}

export async function createCheckLists(cards: TrelloCard[]): Promise<any[]> {
  let responses = [];

  for (let card of cards) {
    for (let checklist of card.checklists) {
      let p = createCheckList(checklist, card.id);
      responses.push(p);
    }
  }

  return Promise.all(responses);
}

export async function createFullBoard(
  name: string,
  inputData: Result,
  listoData: DirectoryData,
): Promise<any> {
  const board = await createBoard(name);

  const listsData = await createLists(
    Object.keys(inputData.selectedModulesByCategory),
    board.id,
  );

  const cards = [];

  // Create the Card's for all selected modules
  for (let category of Object.keys(inputData.selectedModulesByCategory)) {
    for (let moduleKey of inputData.selectedModulesByCategory[category]) {
      const selectedCategory = listoData.data.modules[category];

      const list = listsData.find(list => list.name === category);

      let cardObj: TrelloCard = {
        name: selectedCategory[moduleKey].title,
        category: selectedCategory[moduleKey].category,
        description: selectedCategory[moduleKey].description,
        tags: selectedCategory[moduleKey].tags,
        listId: list.id,
      };

      // Add the checklists to the cards
      const checklists = [];
      for (let checklist of Object.keys(
        selectedCategory[moduleKey].checkLists,
      )) {
        let checkListObj: TrelloCheckList = {
          name: checklist,
          items: selectedCategory[moduleKey].checkLists[checklist].map(
            checklist => ({
              name: checklist.question,
              completed: checklist.tools
                ? checklist.tools.some(checklistTool =>
                    inputData.selectedTools.includes(checklistTool),
                  )
                : false,
            }),
          ),
        };

        checklists.push(checkListObj);
      }
      cardObj.checklists = checklists;
      cards.push(cardObj);
    }
  }

  const cardResponses = await Promise.all(await createCards(cards));

  for (let card of cards) {
    const cardFound = cardResponses.find(
      cardResponse => cardResponse.name === card.name,
    );
    card.id = cardFound.id;
  }

  // create the checklists and checklist items within the cards
  await Promise.all(await createCheckLists(cards));

  return board;
}

export async function addMember(
  boardID: string,
  memberEmail: string,
): Promise<any> {
  const params = new Map([
    ['email', memberEmail],
    ['type', 'normal'],
  ]);
  const url = await buildURL(`boards/${boardID}/members`, params);

  const options = {
    method: 'PUT',
  };

  const res = await fetch(url, options);

  return res.json();
}
