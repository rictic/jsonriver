import { parse } from "jsonriver";

class Renderer {
  prevEnd = 0;
  render(posts) {
    let first = true;
    for (let i = this.prevEnd; i < posts.length; i++) {
      const post = posts[i];
      if (!post.title) {
        // We haven't gotten any of the title yet, skip it.
        continue;
      }
      process.stdout.write(first ? "\r" : "\n");
      process.stdout.write(`${post.id}: ${post.title}`);
      first = false;
      this.prevEnd = i;
    }
  }
}

const response = await fetch(`https://jsonplaceholder.typicode.com/posts`);
const decoded = response.body.pipeThrough(new TextDecoderStream());
const delayed = delay(decoded); // adds fake latency, to simulate a slow network
const postsStream = parse(delayed);

const renderer = new Renderer();
for await (const posts of postsStream) {
  // Each time we see posts, it will be an increasingly complete version
  // of the JSON returned by the server. So we can begin rendering the
  // first results immediately before the rest of the data has even arrived.
  renderer.render(posts);
}
process.stdout.write("\n");

async function* delay(stream) {
  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 4));
      yield chunk[i];
    }
  }
}
