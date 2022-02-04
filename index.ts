import { api, params, data } from "@serverless/cloud";
import axios from "axios";
import SpotifyWebApi from "spotify-web-api-node";

const PLAYLIST_ID = params.SPOTIFY_PLAYLIST_ID;

const spotifyCreds = {
  clientId: params.SPOTIFY_CLIENT_ID,
  clientSecret: params.SPOTIFY_SECRET,
};

const spotify = new SpotifyWebApi({
  clientId: params.SPOTIFY_CLIENT_ID,
  clientSecret: params.SPOTIFY_SECRET,
  redirectUri: params.CLOUD_URL + "/redirect",
});

const postToResponseURL = async (
  url: string,
  channelName: string,
  msg: string
) => {
  await axios.post(url, {
    channel: channelName,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: msg },
      },
    ],
  });
};

api.post("/subscribe", async (req, res) => {
  const channelName = req.body.channel_name;
  const responseUrl = req.body.response_url;
  try {
    if (req.body.channel_id && req.body.team_domain) {
      const channelId = req.body.channel_id;
      const teamId = req.body.team_id;
      await data.set<any>(
        `${teamId}:channel:${channelId}`,
        {
          channelId,
          teamId,
          added: new Date().toISOString(),
        },
        {
          overwrite: true,
        }
      );
      await postToResponseURL(
        req.body.response_url,
        channelId,
        `Subscribed to ${channelName}`
      );
      return res.sendStatus(200);
    }
  } catch (e) {
    if (responseUrl && channelName) {
      await postToResponseURL(
        responseUrl,
        channelName,
        `Error: ${JSON.stringify(e)}`
      );
    }
    return res.status(500).send(e);
  }
});

api.post("/slack", async (req, res) => {
  // For setting up new event listeners for Slack bots
  if (req.body.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }
  const channelId = req.body.event.channel;
  const teamSubscribedChannels = await data.get<any>(
    `${req.body.team_id}:channel:*`
  );
  if (!teamSubscribedChannels.items.length) {
    return res.sendStatus(200);
  }
  const channels = teamSubscribedChannels.items.map((i) => i.value.channelId);
  if (channelId && channels.includes(channelId) && req.body.event.text) {
    const msg = req.body.event.text;
    const msgParts = msg.split("\n");
    const spotifyLinks = msgParts.filter((p) =>
      p.includes("open.spotify.com/track")
    );
    await Promise.all(
      spotifyLinks.map((link) => {
        let trackId = link.split("/")[4];
        if (trackId.includes("?")) {
          trackId = trackId.split("?")[0];
        }
        const spotifyTrackId = `spotify:track:${trackId}`;
        return data.set(
          `track:${trackId}`,
          {
            spotifyTrackId,
          },
          {
            overwrite: true,
          }
        );
      })
    );
  }
  return res.sendStatus(200);
});

api.get("/redirect", async (req, res) => {
  if (req.query.code) {
    console.log(`code: ${req.query.code}`);
    const authData = await spotify.authorizationCodeGrant(req.query.code);
    await data.set(
      "spotify:auth",
      {
        accessToken: authData.body["access_token"],
        refreshToken: authData.body["refresh_token"],
      },
      { overwrite: true }
    );
  }
  return res.sendStatus(200);
});

api.get("/spotify", (req, res) => {
  const scopes = [
    "playlist-modify-private",
    "playlist-modify-public",
    "playlist-read-private",
  ];
  const authUrl = spotify.createAuthorizeURL(scopes);
  return res.redirect(authUrl);
});

data.on(["created:track:*"], async (event) => {
  const { item } = event;
  const authData = await data.get<any>("spotify:auth");
  if (!authData) {
    console.log("No Spotify Auth Saved");
    return;
  }
  spotify.setRefreshToken(authData.refreshToken);
  const refreshData = await spotify.refreshAccessToken();
  spotify.setAccessToken(refreshData.body["access_token"]);
  const spotifyTrackId = item.value.spotifyTrackId;
  const currentSongsOnPlaylist = await spotify.getPlaylistTracks(PLAYLIST_ID);
  const playlistIds = new Set(
    currentSongsOnPlaylist.body.items.map((i) => `spotify:track:${i.track.id}`)
  );
  if (playlistIds.has(spotifyTrackId)) {
    console.log(`${spotifyTrackId} already on playlist`);
    return;
  }
  await spotify.addTracksToPlaylist(PLAYLIST_ID, [spotifyTrackId]);
});
