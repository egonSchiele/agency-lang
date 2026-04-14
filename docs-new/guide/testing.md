# Testing

Agency comes with a built-in testing framework that makes it easy to test your agents. To start, generate fixtures for your agent by running

```
agency test fixtures foo.agency
```

Agency will execute your node and get the return value. If there are multiple nodes, it will ask you which node to execute. If the return value looks correct, you can choose what kind of fixture you want: exact match or LLM as a judge. If you choose LLM as a judge, you'll need to provide a prompt that the LLM can use to judge the result.

After that, the fixtures command will create a test file with the same name as your agency file, but with the .test.json extension instead

```
foo.agency → foo.test.json
```

Then simply run the test using the `test` command, giving either the path to the agency file or the test.json file.

```
agency test foo.agency
agency test foo.test.json
```