// Bound HTTP access to the Mailbox service. The server owns storage and delivery.
export function clientMailbox(client, as) {
  const path = (topic) => `/api/topics/${encodeURIComponent(topic)}`;
  return {
    topics: () => client.request("/api/topics"),
    topic: (topic) => client.request(path(topic)),
    join: (topic) => client.request(`${path(topic)}/members`, { as }),
    read: (topic, after, limit) => client.request(`${path(topic)}/messages?after=${after}&limit=${limit}`),
    inbox: () => client.request(`/api/inbox?as=${encodeURIComponent(as)}`),
    post: (topic, args) => client.request(`${path(topic)}/messages`, { ...args, as }),
    ack: (topic, through) => client.request(`${path(topic)}/ack`, { as, through }),
  };
}
