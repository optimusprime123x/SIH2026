# Image understanding

Gemini models are built to be multimodal from the ground up, unlocking a wide
range of image processing and computer vision tasks including but not limited to
image captioning, classification, and visual question answering without having
to train specialized ML models.

In addition to their general multimodal capabilities, Gemini models offer
**enhanced accuracy** for specific use cases like [object detection](/docs/image-understanding#object-detection) and [segmentation](/docs/image-understanding#segmentation), through additional
training.

## Passing images to Gemini  {% id="image-input" %}

You can provide images as input to Gemini using several methods:

* [Passing image using URL](/docs/image-understanding#url-image): Ideal for publicly accessible images.
* [Passing inline image data](/docs/image-understanding#inline-image): For base64-encoded image data.
* [Uploading images using the File API](/docs/image-understanding#upload-image): Recommended for
  larger files or for reusing images across multiple requests.

### Passing image using URL  {% id="url-image" %}

You can upload an image using the [Files API](/docs/files) and pass it
in the request:

{% tabs %}
  {% tab label="Python" %}
  ```python
  from google import genai
  
  client = genai.Client()
  
  uploaded_file = client.files.upload(file="path/to/organ.jpg")
  
  interaction = client.interactions.create(
      model="gemini-3.7-flash",
      input=[
          {"type": "text", "text": "Caption this image."},
          {
              "type": "image",
              "uri": uploaded_file.uri,
              "mime_type": uploaded_file.mime_type
          }
      ]
  )
  print(interaction.output_text)
  ```

  {% /tab %}

  {% tab label="JavaScript" %}
  ```javascript
  import { GoogleGenAI } from "@google/genai";
  
  const client = new GoogleGenAI({});
  
  const uploadedFile = await client.files.upload({
      file: "path/to/organ.jpg",
      config: { mime_type: "image/jpeg" }
  });
  
  const interaction = await client.interactions.create({
      model: "gemini-3.7-flash",
      input: [
          {type: "text", text: "Caption this image."},
          {
              type: "image",
              uri: uploadedFile.uri,
              mime_type: uploadedFile.mimeType
          }
      ]
  });
  console.log(interaction.output_text);
  ```

  {% /tab %}

  {% tab label="REST" %}
  ```shell
  curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
    -H "x-goog-api-key: $GEMINI_API_KEY" \
    -H 'Content-Type: application/json' \
    -H "Api-Revision: 2026-05-20" \
    -d '{
      "model": "gemini-3.7-flash",
      "input": [
        {"type": "text", "text": "Caption this image."},
        {
          "type": "image",
          "uri": "YOUR_FILE_URI",
          "mime_type": "image/jpeg"
        }
      ]
    }'
  ```

  {% /tab %}

{% /tabs %}

### Passing inline image data  {% id="inline-image" %}

You can provide image data as base64-encoded strings:

{% tabs %}
  {% tab label="Python" %}
  ```python
  import base64
  from google import genai
  
  with open('path/to/small-sample.jpg', 'rb') as f:
      image_bytes = f.read()
  
  client = genai.Client()
  
  interaction = client.interactions.create(
      model="gemini-3.7-flash",
      input=[
          {"type": "text", "text": "Caption this image."},
          {
              "type": "image",
              "data": base64.b64encode(image_bytes).decode('utf-8'),
              "mime_type": "image/jpeg"
          }
      ]
  )
  print(interaction.output_text)
  ```

  {% /tab %}

  {% tab label="JavaScript" %}
  ```javascript
  import { GoogleGenAI } from "@google/genai";
  import * as fs from "node:fs";
  
  const client = new GoogleGenAI({});
  const base64ImageFile = fs.readFileSync("path/to/small-sample.jpg", {
    encoding: "base64",
  });
  
  const interaction = await client.interactions.create({
      model: "gemini-3.7-flash",
      input: [
          {type: "text", text: "Caption this image."},
          {
              type: "image",
              data: base64ImageFile,
              mime_type: "image/jpeg"
          }
      ]
  });
  console.log(interaction.output_text);
  ```

  {% /tab %}

  {% tab label="REST" %}
  ```shell
  IMG_PATH="/path/to/your/image1.jpg"
  
  if [[ "$(base64 --version 2>&1)" = *"FreeBSD"* ]]; then
    B64FLAGS="--input"
  else
    B64FLAGS="-w0"
  fi
  
  curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
    -H "x-goog-api-key: $GEMINI_API_KEY" \
    -H 'Content-Type: application/json' \
    -H "Api-Revision: 2026-05-20" \
    -d '{
      "model": "gemini-3.7-flash",
      "input": [
        {"type": "text", "text": "Caption this image."},
        {
          "type": "image",
          "data": "'"$(base64 $B64FLAGS $IMG_PATH)"'",
          "mime_type": "image/jpeg"
        }
      ]
    }'
  ```

  {% /tab %}

{% /tabs %}

{% callout type="note" %}
  Inline image data limits your total request size (text prompts, system
  instructions, and inline bytes) to 20MB. For larger requests,
  [upload image files](/docs/image-understanding#upload-image) using the File API.

{% /callout %}

### Uploading images using the File API  {% id="upload-image" %}

For large files or to be able to use the same image file repeatedly, use the
Files API. See the [Files API guide](/docs/files).

{% tabs %}
  {% tab label="Python" %}
  ```python
  from google import genai
  
  client = genai.Client()
  
  my_file = client.files.upload(file="path/to/sample.jpg")
  
  interaction = client.interactions.create(
      model="gemini-3.7-flash",
      input=[
          {"type": "text", "text": "Caption this image."},
          {
              "type": "image",
              "uri": my_file.uri,
              "mime_type": my_file.mime_type
          }
      ]
  )
  print(interaction.output_text)
  ```

  {% /tab %}

  {% tab label="JavaScript" %}
  ```javascript
  import { GoogleGenAI } from "@google/genai";
  
  const client = new GoogleGenAI({});
  
  const myfile = await client.files.upload({
      file: "path/to/sample.jpg",
      config: { mimeType: "image/jpeg" },
  });
  
  const interaction = await client.interactions.create({
      model: "gemini-3.7-flash",
      input: [
          {type: "text", text: "Caption this image."},
          {
              type: "image",
              uri: myfile.uri,
              mime_type: myfile.mimeType
          }
      ]
  });
  console.log(interaction.output_text);
  ```

  {% /tab %}

  {% tab label="REST" %}
  ```shell
  
  curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
    -H "x-goog-api-key: $GEMINI_API_KEY" \
    -H 'Content-Type: application/json' \
    -H "Api-Revision: 2026-05-20" \
    -d '{
      "model": "gemini-3.7-flash",
      "input": [
        {"type": "text", "text": "Caption this image."},
        {
          "type": "image",
          "uri": "YOUR_FILE_URI",
          "mime_type": "image/jpeg"
        }
      ]
    }'
  ```

  {% /tab %}

{% /tabs %}

## Prompting with multiple images  {% id="multiple-images" %}

You can provide multiple images in a single prompt by including multiple image
objects in the `input` array:

{% tabs %}
  {% tab label="Python" %}
  ```python
  from google import genai
  
  client = genai.Client()
  
  interaction = client.interactions.create(
      model="gemini-3.7-flash",
      input=[
          {"type": "text", "text": "What is different between these two images?"},
          {
              "type": "image",
              "uri": "https://example.com/image1.jpg",
              "mime_type": "image/jpeg"
          },
          {
              "type": "image",
              "uri": "https://example.com/image2.jpg",
              "mime_type": "image/jpeg"
          }
      ]
  )
  print(interaction.output_text)
  ```

  {% /tab %}

  {% tab label="JavaScript" %}
  ```javascript
  import { GoogleGenAI } from "@google/genai";
  
  const client = new GoogleGenAI({});
  
  const interaction = await client.interactions.create({
      model: "gemini-3.7-flash",
      input: [
          {type: "text", text: "What is different between these two images?"},
          {
              type: "image",
              uri: "https://example.com/image1.jpg",
              mime_type: "image/jpeg"
          },
          {
              type: "image",
              uri: "https://example.com/image2.jpg",
              mime_type: "image/jpeg"
          }
      ]
  });
  console.log(interaction.output_text);
  ```

  {% /tab %}

  {% tab label="REST" %}
  ```shell
  curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
    -H "x-goog-api-key: $GEMINI_API_KEY" \
    -H 'Content-Type: application/json' \
    -H "Api-Revision: 2026-05-20" \
    -d '{
      "model": "gemini-3.7-flash",
      "input": [
        {"type": "text", "text": "What is different between these two images?"},
        {
          "type": "image",
          "uri": "https://example.com/image1.jpg",
          "mime_type": "image/jpeg"
        },
        {
          "type": "image",
          "uri": "https://example.com/image2.jpg",
          "mime_type": "image/jpeg"
        }
      ]
    }'
  ```

  {% /tab %}

{% /tabs %}

## Object detection  {% id="object-detection" %}

Models are trained to detect objects in an
image and get their bounding box coordinates. The coordinates, relative to image
dimensions, scale to \[0, 1000\]. You need to descale these coordinates based on
your original image size.

{% tabs %}
  {% tab label="Python" %}
  ```python
  from google import genai
  from pydantic import BaseModel, Field
  from typing import List
  import json
  
  client = genai.Client()
  prompt = "Detect the all of the prominent items in the image. The box_2d should be [ymin, xmin, ymax, xmax] normalized to 0-1000."
  
  class BoundingBox(BaseModel):
      box_2d: List[int] = Field(description="The 2D bounding box of the item as [ymin, xmin, ymax, xmax] normalized to 0-1000.")
      mask: List[List[int]] = Field(description="The segmentation mask of the item as a polygon of [x,y] coordinates, normalized to 0-1000.")
      label: str = Field(description="A descriptive label for the item.")
  
  class BoundingBoxes(BaseModel):
      boxes: List[BoundingBox]
  
  interaction = client.interactions.create(
      model="gemini-3.7-flash",
      input=[
          {"type": "text", "text": prompt},
          {
              "type": "image",
              "uri": "https://example.com/image.png",
              "mime_type": "image/png"
          }
      ],
      response_format={
          "type": "text",
          "mime_type": "application/json",
          "schema": BoundingBoxes.model_json_schema()
      }
  )
  
  bounding_boxes = BoundingBoxes.model_validate_json(interaction.output_text)
  print(bounding_boxes)
  ```

  {% /tab %}

  {% tab label="JavaScript" %}
  ```javascript
  import { GoogleGenAI } from "@google/genai";
  import * as z from "zod";
  
  const client = new GoogleGenAI({});
  const prompt = "Detect the all of the prominent items in the image. The box_2d should be [ymin, xmin, ymax, xmax] normalized to 0-1000.";
  
  const boundingBoxesSchema = z.object({
    boxes: z.array(z.object({
      box_2d: z.array(z.number()),
      mask: z.array(z.array(z.number())),
      label: z.string()
    }))
  });
  
  const interaction = await client.interactions.create({
    model: "gemini-3.7-flash",
    input: [
      { type: "text", text: prompt },
      {
        type: "image",
        uri: "https://example.com/image.png",
        mime_type: "image/png"
      }
    ],
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: z.toJSONSchema(boundingBoxesSchema)
    },
  });
  
  const result = boundingBoxesSchema.parse(JSON.parse(interaction.output_text));
  console.log(result);
  ```

  {% /tab %}

  {% tab label="REST" %}
  ```bash
  curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
    -H "x-goog-api-key: $GEMINI_API_KEY" \
    -H 'Content-Type: application/json' \
    -H "Api-Revision: 2026-05-20" \
    -d '{
      "model": "gemini-3.7-flash",
      "input": [
        {"type": "text", "text": "Detect the all of the prominent items in the image. The box_2d should be [ymin, xmin, ymax, xmax] normalized to 0-1000."},
        {
          "type": "image",
          "uri": "https://example.com/image.png",
          "mime_type": "image/png"
        }
      ],
      "response_format": {
        "type": "text",
        "mime_type": "application/json",
        "schema": {
          "type": "object",
          "properties": {
            "boxes": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "box_2d": { "type": "array", "items": { "type": "integer" } },
                  "mask": { "type": "array", "items": { "type": "array", "items": { "type": "integer" } } },
                  "label": { "type": "string" }
                },
                "required": ["box_2d", "mask", "label"]
              }
            }
          },
          "required": ["boxes"]
        }
      }
    }'
  ```

  {% /tab %}

{% /tabs %}

{% callout type="note" %}
  The model also supports generating bounding boxes based on custom
  instructions, such as: "Show bounding boxes of all green objects in this image".

{% /callout %}

For more examples, check following notebooks in the [Gemini Cookbook](https://github.com/google-gemini/cookbook):

## Segmentation  {% id="segmentation" %}

Starting with Gemini 2.5, models not only detect items but also segment them
and provide their contour masks.

The model predicts a JSON list, where each item represents a segmentation mask.
Each item has a bounding box ("`box_2d`") in the format `[y0, x0, y1, x1]` with
normalized coordinates between 0 and 1000, a label ("`label`") that identifies
the object, and finally the segmentation mask inside the bounding box, as base64
encoded png that is a probability map with values between 0 and 255.

{% callout type="note" %}
  For better results, disable [thinking](/docs/thinking)
  by setting the thinking level to "minimal".

{% /callout %}

{% tabs %}
  {% tab label="Python" %}
  ```python
  from google import genai
  from pydantic import BaseModel, Field
  from typing import List
  import json
  
  client = genai.Client()
  
  prompt = """
  Give the segmentation masks for the wooden and glass items.
  Output a JSON list of segmentation masks where each entry contains the 2D
  bounding box in the key "box_2d", the segmentation mask in key "mask", and
  the text label in the key "label". Use descriptive labels.
  """
  
  class BoundingBox(BaseModel):
      box_2d: List[int] = Field(description="The 2D bounding box of the item as [ymin, xmin, ymax, xmax] normalized to 0-1000.")
      mask: List[List[int]] = Field(description="The segmentation mask of the item as a polygon of [x,y] coordinates, normalized to 0-1000.")
      label: str = Field(description="A descriptive label for the item.")
  
  class BoundingBoxes(BaseModel):
      boxes: List[BoundingBox]
  
  interaction = client.interactions.create(
      model="gemini-3.7-flash",
      input=[
          {"type": "text", "text": prompt},
          {
              "type": "image",
              "uri": "https://example.com/image.png",
              "mime_type": "image/png"
          }
      ],
      response_format={
          "type": "text",
          "mime_type": "application/json",
          "schema": BoundingBoxes.model_json_schema()
      },
      generation_config={
          "thinking_level": "minimal"
      }
  )
  
  items = BoundingBoxes.model_validate_json(interaction.output_text)
  print("Segmentation results:", items)
  ```

  {% /tab %}

  {% tab label="JavaScript" %}
  ```javascript
  import { GoogleGenAI } from "@google/genai";
  import * as z from "zod";
  
  const client = new GoogleGenAI({});
  const prompt = `
  Give the segmentation masks for the wooden and glass items.
  Output a JSON list of segmentation masks where each entry contains the 2D
  bounding box in the key "box_2d", the segmentation mask in key "mask", and
  the text label in the key "label". Use descriptive labels.
  `;
  
  const boundingBoxesSchema = z.object({
    boxes: z.array(z.object({
      box_2d: z.array(z.number()),
      mask: z.array(z.array(z.number())),
      label: z.string()
    }))
  });
  
  const interaction = await client.interactions.create({
    model: "gemini-3.7-flash",
    input: [
      { type: "text", text: prompt },
      {
        type: "image",
        uri: "https://example.com/image.png",
        mime_type: "image/png"
      }
    ],
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: z.toJSONSchema(boundingBoxesSchema)
    },
    generation_config: {
      thinking_level: "minimal"
    }
  });
  
  const result = boundingBoxesSchema.parse(JSON.parse(interaction.output_text));
  console.log(result);
  ```

  {% /tab %}

  {% tab label="REST" %}
  ```bash
  curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
    -H "x-goog-api-key: $GEMINI_API_KEY" \
    -H 'Content-Type: application/json' \
    -H "Api-Revision: 2026-05-20" \
    -d '{
      "model": "gemini-3.7-flash",
      "input": [
        {"type": "text", "text": "Give the segmentation masks for the wooden and glass items.\nOutput a JSON list of segmentation masks where each entry contains the 2D\nbounding box in the key \"box_2d\", the segmentation mask in key \"mask\", and\nthe text label in the key \"label\". Use descriptive labels."},
        {
          "type": "image",
          "uri": "https://example.com/image.png",
          "mime_type": "image/png"
        }
      ],
      "response_format": {
        "type": "text",
        "mime_type": "application/json",
        "schema": {
          "type": "object",
          "properties": {
            "boxes": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "box_2d": { "type": "array", "items": { "type": "integer" } },
                  "mask": { "type": "array", "items": { "type": "array", "items": { "type": "integer" } } },
                  "label": { "type": "string" }
                },
                "required": ["box_2d", "mask", "label"]
              }
            }
          },
          "required": ["boxes"]
        }
      },
      "generation_config": {
        "thinking_level": "minimal"
      }
    }'
  ```

  {% /tab %}

{% /tabs %}

![](https://www.gstatic.com/aistudio/documentation/en/gemini-api/docs/images/segmentation.jpg)## Supported image formats  {% id="supported-formats" %}

Gemini supports the following image format MIME types:

* PNG - `image/png`
* JPEG - `image/jpeg`
* WEBP - `image/webp`
* HEIC - `image/heic`
* HEIF - `image/heif`

To learn about other file input methods, see the
[File input methods](/docs/file-input-methods) guide.

## Capabilities  {% id="capabilities" %}

All Gemini model versions are multimodal and can be utilized in a wide range
of image processing and computer vision tasks including but not limited to
image captioning, visual question and answering, image classification,
object detection and segmentation.

Gemini can reduce the need to use specialized ML models depending on your
quality and performance requirements.

The latest model versions are specifically trained improve accuracy of
specialized tasks in addition to generic capabilities, like enhanced
[object detection](/docs/image-understanding#object-detection) and [segmentation](/docs/image-understanding#segmentation).

## Limitations and key technical information  {% id="technical-details-image" %}

### File limit  {% id="file-limit" %}

Gemini models support a maximum of 3,600 image files per request.

### Token calculation  {% id="token-calculation" %}

* 258 tokens if both dimensions <= 384 pixels.
  Larger images are tiled into 768x768 pixel tiles, each costing 258 tokens.

A rough formula for calculating the number of tiles is as follows:

* Calculate the crop unit size which is roughly: `floor(min(width, height)` / 1.5).
* Divide each dimension by the crop unit size and multiply together to get the
  number of tiles.

For example, for an image of dimensions 960x540 would have a crop unit size
of 360. Divide each dimension by 360 and the number of tile is 3 * 2 = 6.

### Media resolution  {% id="media-resolution" %}

Gemini 3 introduces granular control over multimodal vision processing with the
`media_resolution` parameter. The `media_resolution` parameter determines the
**maximum number of tokens allocated per input image or video frame.**
Higher resolutions improve the model's ability to
read fine text or identify small details, but increase token usage and latency.

## Tips and best practices  {% id="tips-best-practices" %}

* Verify that images are correctly rotated.
* Use clear, non-blurry images.
* When using a single image with text, place the text prompt *before* the image in the `input` array.

## What's next  {% id="whats-next" %}

This guide shows you how to upload image files and generate text outputs
from image inputs. To learn more, see the following resources:

*   [Files API](/docs/files): Learn more about uploading and managing files for use with Gemini.

*   [System instructions](/docs/text-generation#system-instructions):
  System instructions let you steer the behavior of the model based on your
  specific needs and use cases.

*   [File prompting strategies](/docs/files#prompt-guide): The
  Gemini API supports prompting with text, image, audio, and video data, also
  known as multimodal prompting.

*   [Safety guidance](/docs/safety-guidance): Sometimes generative
  AI models produce unexpected outputs, such as outputs that are inaccurate,
  biased, or offensive. Post-processing and human evaluation are essential to
  limit the risk of harm from such outputs.


# Structured outputs

You can configure Gemini models to generate responses that adhere to a provided
JSON Schema. This ensures predictable, type-safe results and simplifies
extracting structured data from unstructured text.

Using structured outputs is ideal for:

* **Data extraction:** Pull specific information like names and dates from text.
* **Structured classification:** Classify text into predefined categories.
* **Agentic workflows:** Generate structured inputs for tools or APIs.

In addition to supporting JSON Schema in the REST API, the Google GenAI SDKs
allow defining schemas using
[Pydantic](https://docs.pydantic.dev/latest/) (Python) and
[Zod](https://zod.dev/) (JavaScript).

## Structured output examples  {% id="structured-output-examples" %}

### Recipe Extractor  {% id="recipe" %}

This example demonstrates how to extract structured data from text using basic
JSON Schema types like `object`, `array`, `string`, and `integer`.

{% tabs %}
  {% tab label="Python" %}
  ```python
  from google import genai
  from pydantic import BaseModel, Field
  from typing import List, Optional
  
  class Ingredient(BaseModel):
      name: str = Field(description="Name of the ingredient.")
      quantity: str = Field(description="Quantity of the ingredient, including units.")
  
  class Recipe(BaseModel):
      recipe_name: str = Field(description="The name of the recipe.")
      prep_time_minutes: Optional[int] = Field(description="Optional time in minutes to prepare the recipe.")
      ingredients: List[Ingredient]
      instructions: List[str]
  
  client = genai.Client()
  
  prompt = """
  Please extract the recipe from the following text.
  The user wants to make delicious chocolate chip cookies.
  They need 2 and 1/4 cups of all-purpose flour, 1 teaspoon of baking soda,
  1 teaspoon of salt, 1 cup of unsalted butter (softened), 3/4 cup of granulated sugar,
  3/4 cup of packed brown sugar, 1 teaspoon of vanilla extract, and 2 large eggs.
  For the best part, they'll need 2 cups of semisweet chocolate chips.
  First, preheat the oven to 375°F (190°C). Then, in a small bowl, whisk together the flour,
  baking soda, and salt. In a large bowl, cream together the butter, granulated sugar, and brown sugar
  until light and fluffy. Beat in the vanilla and eggs, one at a time. Gradually beat in the dry
  ingredients until just combined. Finally, stir in the chocolate chips. Drop by rounded tablespoons
  onto ungreased baking sheets and bake for 9 to 11 minutes.
  """
  
  interaction = client.interactions.create(
      model="gemini-3.7-flash",
      input=prompt,
      response_format={
          "type": "text",
          "mime_type": "application/json",
          "schema": Recipe.model_json_schema()
      },
  )
  
  recipe = Recipe.model_validate_json(interaction.output_text)
  print(recipe)
  ```

  {% /tab %}

  {% tab label="JavaScript" %}
  ```javascript
  import { GoogleGenAI } from "@google/genai";
  import * as z from "zod";
  
  const recipeJsonSchema = {
    type: "object",
    properties: {
      recipe_name: {
        type: "string",
        description: "The name of the recipe."
      },
      prep_time_minutes: {
          type: "integer",
          description: "Optional time in minutes to prepare the recipe."
      },
      ingredients: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Name of the ingredient."},
            quantity: { type: "string", description: "Quantity of the ingredient, including units."}
          },
          required: ["name", "quantity"]
        }
      },
      instructions: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["recipe_name", "ingredients", "instructions"]
  };
  
  const recipeSchema = z.fromJSONSchema(recipeJsonSchema);
  
  const client = new GoogleGenAI({});
  
  const prompt = `
  Please extract the recipe from the following text.
  The user wants to make delicious chocolate chip cookies.
  They need 2 and 1/4 cups of all-purpose flour, 1 teaspoon of baking soda,
  1 teaspoon of salt, 1 cup of unsalted butter (softened), 3/4 cup of granulated sugar,
  3/4 cup of packed brown sugar, 1 teaspoon of vanilla extract, and 2 large eggs.
  For the best part, they'll need 2 cups of semisweet chocolate chips.
  First, preheat the oven to 375°F (190°C). Then, in a small bowl, whisk together the flour,
  baking soda, and salt. In a large bowl, cream together the butter, granulated sugar, and brown sugar
  until light and fluffy. Beat in the vanilla and eggs, one at a time. Gradually beat in the dry
  ingredients until just combined. Finally, stir in the chocolate chips. Drop by rounded tablespoons
  onto ungreased baking sheets and bake for 9 to 11 minutes.
  `;
  
  const interaction = await client.interactions.create({
    model: "gemini-3.7-flash",
    input: prompt,
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: recipeJsonSchema
    },
  });
  
  const recipe = recipeSchema.parse(JSON.parse(interaction.output_text));
  console.log(recipe);
  ```

  {% /tab %}

  {% tab label="REST" %}
  ```shell
  curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
      -H "x-goog-api-key: $GEMINI_API_KEY" \
      -H 'Content-Type: application/json' \
      -H "Api-Revision: 2026-05-20" \
      -d '{
        "model": "gemini-3.7-flash",
        "input": "Please extract the recipe from the following text.\nThe user wants to make delicious chocolate chip cookies.\nThey need 2 and 1/4 cups of all-purpose flour, 1 teaspoon of baking soda,\n1 teaspoon of salt, 1 cup of unsalted butter (softened), 3/4 cup of granulated sugar,\n3/4 cup of packed brown sugar, 1 teaspoon of vanilla extract, and 2 large eggs.\nFor the best part, they will need 2 cups of semisweet chocolate chips.\nFirst, preheat the oven to 375°F (190°C). Then, in a small bowl, whisk together the flour,\nbaking soda, and salt. In a large bowl, cream together the butter, granulated sugar, and brown sugar\nuntil light and fluffy. Beat in the vanilla and eggs, one at a time. Gradually beat in the dry\ningredients until just combined. Finally, stir in the chocolate chips. Drop by rounded tablespoons\nonto ungreased baking sheets and bake for 9 to 11 minutes.",
        "response_format": {
          "type": "text",
          "mime_type": "application/json",
          "schema": {
            "type": "object",
            "properties": {
              "recipe_name": {
                "type": "string",
                "description": "The name of the recipe."
              },
              "prep_time_minutes": {
                  "type": "integer",
                  "description": "Optional time in minutes to prepare the recipe."
              },
              "ingredients": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": { "type": "string", "description": "Name of the ingredient."},
                    "quantity": { "type": "string", "description": "Quantity of the ingredient, including units."}
                  },
                  "required": ["name", "quantity"]
                }
              },
              "instructions": {
                "type": "array",
                "items": { "type": "string" }
              }
            },
            "required": ["recipe_name", "ingredients", "instructions"]
          }
        }
        }
      }'
  ```

  {% /tab %}

{% /tabs %}

**Example Response:**

```json
{
  "recipe_name": "Delicious Chocolate Chip Cookies",
  "ingredients": [
    { "name": "all-purpose flour", "quantity": "2 and 1/4 cups" },
    { "name": "baking soda", "quantity": "1 teaspoon" },
    { "name": "salt", "quantity": "1 teaspoon" },
    { "name": "unsalted butter (softened)", "quantity": "1 cup" },
    { "name": "granulated sugar", "quantity": "3/4 cup" },
    { "name": "packed brown sugar", "quantity": "3/4 cup" },
    { "name": "vanilla extract", "quantity": "1 teaspoon" },
    { "name": "large eggs", "quantity": "2" },
    { "name": "semisweet chocolate chips", "quantity": "2 cups" }
  ],
  "instructions": [
    "Preheat the oven to 375°F (190°C).",
    "In a small bowl, whisk together the flour, baking soda, and salt.",
    "In a large bowl, cream together the butter, granulated sugar, and brown sugar until light and fluffy.",
    "Beat in the vanilla and eggs, one at a time.",
    "Gradually beat in the dry ingredients until just combined.",
    "Stir in the chocolate chips.",
    "Drop by rounded tablespoons onto ungreased baking sheets and bake for 9 to 11 minutes."
  ]
}
```

### Content Moderation  {% id="feedback" %}

This example showcases `anyOf` for conditional schemas and `enum` for
classification, allowing the output structure to vary based on the content.

{% tabs %}
  {% tab label="Python" %}
  ```python
  from google import genai
  from pydantic import BaseModel, Field
  from typing import Union, Literal
  
  class SpamDetails(BaseModel):
      reason: str = Field(description="The reason why the content is considered spam.")
      spam_type: Literal["phishing", "scam", "unsolicited promotion", "other"] = Field(description="The type of spam.")
  
  class NotSpamDetails(BaseModel):
      summary: str = Field(description="A brief summary of the content.")
      is_safe: bool = Field(description="Whether the content is safe for all audiences.")
  
  class ModerationResult(BaseModel):
      decision: Union[SpamDetails, NotSpamDetails]
  
  client = genai.Client()
  
  prompt = """
  Please moderate the following content and provide a decision.
  Content: 'Congratulations! You''ve won a free cruise to the Bahamas. Click here to claim your prize: www.definitely-not-a-scam.com'
  """
  
  interaction = client.interactions.create(
      model="gemini-3.7-flash",
      input=prompt,
      response_format={
          "type": "text",
          "mime_type": "application/json",
          "schema": ModerationResult.model_json_schema()
      },
  )
  
  result = ModerationResult.model_validate_json(interaction.output_text)
  print(result)
  ```

  {% /tab %}

  {% tab label="JavaScript" %}
  ```javascript
  import { GoogleGenAI } from "@google/genai";
  import * as z from "zod";
  
  const moderationResultJsonSchema = {
    type: "object",
    properties: {
      decision: {
        anyOf: [
          {
            type: "object",
            title: "SpamDetails",
            description: "Details for content classified as spam.",
            properties: {
              reason: { type: "string", description: "The reason why the content is considered spam." },
              spam_type: { type: "string", enum: ["phishing", "scam", "unsolicited promotion", "other"], description: "The type of spam." }
            },
            required: ["reason", "spam_type"]
          },
          {
            type: "object",
            title: "NotSpamDetails",
            description: "Details for content classified as not spam.",
            properties: {
              summary: { type: "string", description: "A brief summary of the content." },
              is_safe: { type: "boolean", description: "Whether the content is safe for all audiences." }
            },
            required: ["summary", "is_safe"]
          }
        ]
      }
    },
    required: ["decision"]
  };
  
  const moderationResultSchema = z.fromJSONSchema(moderationResultJsonSchema);
  
  const client = new GoogleGenAI({});
  
  const prompt = `
  Please moderate the following content and provide a decision.
  Content: 'Congratulations! You''ve won a free cruise to the Bahamas. Click here to claim your prize: www.definitely-not-a-scam.com'
  `;
  
  const interaction = await client.interactions.create({
    model: "gemini-3.7-flash",
    input: prompt,
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: moderationResultJsonSchema
    },
  });
  
  const result = moderationResultSchema.parse(JSON.parse(interaction.output_text));
  console.log(result);
  ```

  {% /tab %}

  {% tab label="REST" %}
  ```shell
  curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
      -H "x-goog-api-key: $GEMINI_API_KEY" \
      -H 'Content-Type: application/json' \
      -H "Api-Revision: 2026-05-20" \
      -d '{
        "model": "gemini-3.7-flash",
        "input": "Please moderate the following content and provide a decision.\nContent: '\''Congratulations! You have won a free cruise to the Bahamas. Click here to claim your prize: www.definitely-not-a-scam.com'\''",
        "response_format": {
          "type": "text",
          "mime_type": "application/json",
          "schema": {
            "type": "object",
            "properties": {
              "decision": {
                "anyOf": [
                  {
                    "type": "object",
                    "title": "SpamDetails",
                    "description": "Details for content classified as spam.",
                    "properties": {
                      "reason": { "type": "string", "description": "The reason why the content is considered spam." },
                      "spam_type": { "type": "string", "enum": ["phishing", "scam", "unsolicited promotion", "other"], "description": "The type of spam." }
                    },
                    "required": ["reason", "spam_type"]
                  },
                  {
                    "type": "object",
                    "title": "NotSpamDetails",
                    "description": "Details for content classified as not spam.",
                    "properties": {
                      "summary": { "type": "string", "description": "A brief summary of the content." },
                      "is_safe": { "type": "boolean", "description": "Whether the content is safe for all audiences." }
                    },
                    "required": ["summary", "is_safe"]
                  }
                ]
              }
            },
            "required": ["decision"]
          }
        }
        }
      }'
  ```

  {% /tab %}

{% /tabs %}

**Example Response:**

```json
{
  "decision": {
    "reason": "The content is an unsolicited prize notification attempting to trick the user into clicking a suspicious link.",
    "spam_type": "scam"
  }
}
```

### Recursive Structures  {% id="recursive" %}

This example illustrates how to define a recursive schema such as an
organization chart.

{% tabs %}
  {% tab label="Python" %}
  ```python
  from google import genai
  from pydantic import BaseModel, Field
  from typing import List
  
  class Employee(BaseModel):
      """Represents an employee in an organization."""
      name: str
      employee_id: int
      reports: List["Employee"] = Field(
          default_factory=list,
          description="A list of employees reporting to this employee."
      )
  
  client = genai.Client()
  
  prompt = """
  Generate an organization chart for a small team.
  The manager is Alice, who manages Bob and Charlie. Bob manages David.
  """
  
  interaction = client.interactions.create(
      model="gemini-3.7-flash",
      input=prompt,
      response_format={
          "type": "text",
          "mime_type": "application/json",
          "schema": Employee.model_json_schema()
      },
  )
  
  employee = Employee.model_validate_json(interaction.output_text)
  print(employee)
  ```

  {% /tab %}

  {% tab label="JavaScript" %}
  ```javascript
  import { GoogleGenAI } from "@google/genai";
  import * as z from "zod";
  
  const employeeJsonSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      employee_id: { type: "integer" },
      reports: {
        type: "array",
        description: "A list of employees reporting to this employee.",
        items: {
          "$ref": "#"
        }
      }
    },
    required: ["name", "employee_id", "reports"]
  };
  
  const employeeSchema = z.fromJSONSchema(employeeJsonSchema);
  
  const client = new GoogleGenAI({});
  
  const prompt = `
  Generate an organization chart for a small team.
  The manager is Alice, who manages Bob and Charlie. Bob manages David.
  `;
  
  const interaction = await client.interactions.create({
    model: "gemini-3.7-flash",
    input: prompt,
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: employeeJsonSchema
    },
  });
  
  const employee = employeeSchema.parse(JSON.parse(interaction.output_text));
  console.log(employee);
  ```

  {% /tab %}

  {% tab label="REST" %}
  ```shell
  curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
      -H "x-goog-api-key: $GEMINI_API_KEY" \
      -H 'Content-Type: application/json' \
      -H "Api-Revision: 2026-05-20" \
      -d '{
        "model": "gemini-3.7-flash",
        "input": "Generate an organization chart for a small team.\nThe manager is Alice, who manages Bob and Charlie. Bob manages David.",
        "response_format": {
          "type": "text",
          "mime_type": "application/json",
          "schema": {
            "type": "object",
            "properties": {
              "name": { "type": "string" },
              "employee_id": { "type": "integer" },
              "reports": {
                "type": "array",
                "description": "A list of employees reporting to this employee.",
                "items": {
                  "$ref": "#"
                }
              }
            },
            "required": ["name", "employee_id", "reports"]
          }
        }
        }
      }'
  ```

  {% /tab %}

{% /tabs %}

**Example Response:**

```json
{
  "name": "Alice",
  "employee_id": 101,
  "reports": [
    {
      "name": "Bob",
      "employee_id": 102,
      "reports": [
        {
          "name": "David",
          "employee_id": 104,
          "reports": []
        }
      ]
    },
    {
      "name": "Charlie",
      "employee_id": 103,
      "reports": []
    }
  ]
}
```

## Streaming results  {% id="streaming" %}

You can stream structured outputs, allowing you to start processing the
response as it's being generated. The streamed chunks are valid partial JSON
strings that can be concatenated to form the final JSON object.

{% tabs %}
  {% tab label="Python" %}
  ```python
  from google import genai
  from pydantic import BaseModel
  from typing import Literal
  
  class Feedback(BaseModel):
      sentiment: Literal["positive", "neutral", "negative"]
      summary: str
  
  client = genai.Client()
  prompt = "The new UI is incredibly intuitive. Add a very long summary to test streaming!"
  
  stream = client.interactions.create(
      model="gemini-3.7-flash",
      input=prompt,
      response_format={
          "type": "text",
          "mime_type": "application/json",
          "schema": Feedback.model_json_schema()
      },
      stream=True
  )
  for event in stream:
      if event.event_type == "step.delta" and event.delta.text:
          print(event.delta.text, end="")
  ```

  {% /tab %}

  {% tab label="JavaScript" %}
  ```javascript
  import { GoogleGenAI } from "@google/genai";
  import * as z from "zod";
  
  const feedbackJsonSchema = {
    type: "object",
    properties: {
      sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
      summary: { type: "string" }
    },
    required: ["sentiment", "summary"]
  };
  
  const feedbackSchema = z.fromJSONSchema(feedbackJsonSchema);
  
  const client = new GoogleGenAI({});
  
  const stream = await client.interactions.create({
    model: "gemini-3.7-flash",
    input: "The new UI is incredibly intuitive. Add a very long summary!",
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: feedbackJsonSchema
    },
    stream: true,
  });
  
  for await (const event of stream) {
    if (event.type === "step.delta" && event.delta?.text) {
      process.stdout.write(event.delta.text);
    }
  }
  ```

  {% /tab %}

{% /tabs %}

## Structured outputs with tools  {% id="tools" %}

{% callout type="note" %}
  Preview: This feature is available only to Gemini 3 series models.

{% /callout %}

Gemini 3 lets you combine Structured Outputs with built-in tools, including
[Grounding with Google Search](/docs/google-search),
[URL Context](/docs/url-context),
[Code Execution](/docs/code-execution),
[File Search](/docs/file-search#structured-output), and
[Function Calling](/docs/function-calling).

{% tabs %}
  {% tab label="Python" %}
  ```python
  from google import genai
  from pydantic import BaseModel, Field
  from typing import List
  
  class MatchResult(BaseModel):
      winner: str = Field(description="The name of the winner.")
      final_match_score: str = Field(description="The final match score.")
      scorers: List[str] = Field(description="The name of the scorer.")
  
  client = genai.Client()
  
  interaction = client.interactions.create(
      model="gemini-3.1-pro-preview",
      input="Search for all details for the latest Euro.",
      tools=[{"type": "google_search"}, {"type": "url_context"}],
      response_format={
          "type": "text",
          "mime_type": "application/json",
          "schema": MatchResult.model_json_schema()
      },
  )
  
  result = MatchResult.model_validate_json(interaction.output_text)
  print(result)
  ```

  {% /tab %}

  {% tab label="JavaScript" %}
  ```javascript
  import { GoogleGenAI } from "@google/genai";
  import * as z from "zod";
  
  const matchJsonSchema = {
    type: "object",
    properties: {
      winner: { type: "string" },
      final_match_score: { type: "string" },
      scorers: { type: "array", items: { type: "string" } }
    },
    required: ["winner", "final_match_score", "scorers"]
  };
  
  const matchSchema = z.fromJSONSchema(matchJsonSchema);
  
  const client = new GoogleGenAI({});
  
  const interaction = await client.interactions.create({
    model: "gemini-3.1-pro-preview",
    input: "Search for all details for the latest Euro.",
    tools: [{type: "google_search"}, {type: "url_context"}],
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: matchJsonSchema
    },
  });
  
  const match = matchSchema.parse(JSON.parse(interaction.output_text));
  console.log(match);
  ```

  {% /tab %}

  {% tab label="REST" %}
  ```shell
  curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
    -H "x-goog-api-key: $GEMINI_API_KEY" \
    -H 'Content-Type: application/json' \
    -H "Api-Revision: 2026-05-20" \
    -d '{
      "model": "gemini-3.1-pro-preview",
      "input": "Search for all details for the latest Euro.",
      "tools": [{"type": "google_search"}, {"type": "url_context"}],
      "response_format": {
        "type": "text",
        "mime_type": "application/json",
        "schema": {
          "type": "object",
          "properties": {
              "winner": {"type": "string"},
              "final_match_score": {"type": "string"},
              "scorers": {"type": "array", "items": {"type": "string"}}
          },
          "required": ["winner", "final_match_score", "scorers"]
        }
      }
    }'
  ```

  {% /tab %}

{% /tabs %}

## JSON schema support  {% id="json-schema-support" %}

To generate a JSON object, configure `response_format` with an object (or an
array containing an object) of type `text` and set its `mime_type` to
`application/json`. The schema should be provided in the `schema` field.

Gemini's structured output mode supports a subset of the
[JSON Schema](https://json-schema.org/) specification.

The following values of `type` are supported:

* **`string`**: For text.
* **`number`**: For floating-point numbers.
* **`integer`**: For whole numbers.
* **`boolean`**: For true or false values.
* **`object`**: For structured data with key-value pairs.
* **`array`**: For lists of items.
* **`null`**: To allow a property to be null, include `"null"` in the type array
  (e.g., `{"type": ["string", "null"]}`).

These descriptive properties help guide the model:

* **`title`**: A short description of a property.
* **`description`**: A longer and more detailed description of a property.

### Type-specific properties  {% id="type-specific-properties" %}

**For `object` values:**

* **`properties`**: An object where each key is a property name and each value
  is a schema for that property.
* **`required`**: An array of strings, listing which properties are mandatory.
* **`additionalProperties`**: Controls whether properties not listed in
  `properties` are allowed. Can be a boolean or a schema.

**For `string` values:**

* **`enum`**: Lists a specific set of possible strings for classification tasks.
* **`format`**: Specifies a syntax for the string, such as `date-time`, `date`,
  `time`.

**For `number` and `integer` values:**

* **`enum`**: Lists a specific set of possible numeric values.
* **`minimum`**: The minimum inclusive value.
* **`maximum`**: The maximum inclusive value.

**For `array` values:**

* **`items`**: Defines the schema for all items in the array.
* **`prefixItems`**: Defines a list of schemas for the first N items, allowing
  for tuple-like structures.
* **`minItems`**: The minimum number of items in the array.
* **`maxItems`**: The maximum number of items in the array.

## Structured outputs versus function calling  {% id="vs-function-calling" %}

| Feature | Primary Use Case |
| :--- | :--- |
| **Structured Outputs** | **Formatting the final response.** Use when you want the model's *answer* in a specific format. |
| **Function Calling** | **Taking action during conversation.** Use when the model needs to *ask you* to perform a task before providing a final answer. |

## Best practices  {% id="best-practices" %}

* **Clear descriptions:** Use the `description` field to guide the model.
* **Strong typing:** Use specific types (`integer`, `string`, `enum`).
* **Prompt engineering:** Clearly state what you want the model to do.
* **Validation:** While output is syntactically correct JSON, always validate
  values in your application.
* **Error handling:** Implement robust error handling for schema-compliant but
  semantically incorrect outputs.

## Limitations  {% id="limitations" %}

* **Schema subset:** Not all JSON Schema features are supported.
* **Schema complexity:** Very large or deeply nested schemas may be rejected.

