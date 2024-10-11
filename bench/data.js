const response = await fetch(`../vendor/testdata/small-file.json`);
export const smallJsonString = await response.text();
